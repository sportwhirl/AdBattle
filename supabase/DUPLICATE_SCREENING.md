# Duplicate-image screening

The starting branch contained `pending_scan` moderation fields and a staging
comment saying that no scanner trigger was installed. It did not contain the
previously described SHA-256 scanner. This change extends that moderation row
rather than creating a second publication state.

## Checks and decisions

`scan-ad-duplicate` is started by a Supabase Database Webhook on `public.ads`
`INSERT`, using `POST /functions/v1/scan-ad-duplicate`. Configure the private
header `x-adbattle-duplicate-scanner-secret: <private secret>` from the
`DUPLICATE_SCANNER_WEBHOOK_SECRET` environment secret. The secret must never be
placed in browser code. The browser only reports that the new ad remains
pending; it does not start the scan.

The normal webhook body is `{ "type": "INSERT", "table": "ads", "schema":
"public", "record": { "id": ... } }`. Only `record.id` is extracted. The
function reloads the authoritative owner, storage path, and screening state
from the database and ignores any other creative fields in the webhook body.

`scan-ad-duplicate` first requires the database path to be inside `<ad.user_id>/`, reads
trusted object metadata, and rejects objects over 10 MiB before download. It
then downloads the untouched object, repeats the size check, validates matching
JPEG or PNG MIME/magic bytes, computes SHA-256, then decodes a working
copy and resizes it to 9×8 for a 64-bit luminance difference hash (dHash).
On-site/source objects are never rendered, stamped, or overwritten.
GIF and WebP are temporarily rejected by the browser, duplicate scanner, and
safety scanner until their complete decode and review paths are supported.

The database serializes comparison decisions and checks all indexed images:

- same owner + same SHA-256: `duplicate_same_creator`, linked to the first ad;
- another owner + same SHA-256: `review_identical`;
- dHash Hamming distance 0–8: `review_similar` for side-by-side review;
- no match: duplicate status `passed` (not a claim of originality); and
- download, decode, or persistence failure: remains `pending`.

Safety and duplicate statuses are independent. The database publication gate
only derives `approved` after both are `passed`; neither pass overrides the
other check's pending, held, or failed result.

Safety scanner decisions are terminal. Only `pending` may transition to
`passed`, `held`, or `failed`; repeating the same terminal result is idempotent,
while a different terminal result is rejected. `scan-ad` reloads
`safety_status` and skips all validation and OpenAI work once a terminal result
exists, even if duplicate screening still keeps the ad pending. Operational
failures leave safety `pending` so a later webhook delivery can retry. The optional [private moderation review migration](MODERATION_REVIEW.md)
adds a separate authenticated moderator path for resolving a safety `held` state;
scanner retries still cannot override it.

### Historical policy response parsing and staging retry

The safety scanner calls the OpenAI Responses API with raw `fetch`. Generated
text must be read from assistant messages in `output[].content[]` with type
`output_text`; the top-level `output_text` shortcut is an SDK helper. Reasoning
items may appear before the message. See the [official text-generation
guide](https://developers.openai.com/api/docs/guides/text).

The scanner requires a completed response and completed assistant messages,
rejects refusals and incomplete/error responses, then validates the policy JSON
against the requested decision fields before recording a safety result. Missing
text, malformed decisions, and contradictory approvals leave safety pending
with a diagnostic error. It never approves because parsing or the API failed.
Raw model output is not included in policy parsing/HTTP error messages.
The configured model, reasoning effort, and 700-token output cap are unchanged;
an incomplete result now reports `max_output_tokens` or `content_filter` when
provided, rather than being mistaken for missing SDK output.

The staging upload test on 2026-09-23 reached duplicate `passed` but safety
`pending` with `OpenAI policy review returned no output_text.` The parser-only
repair at that checkpoint required redeploying only `scan-ad` to
**adbattle-test**, preserving `verify_jwt=false` and the existing private
`x-adbattle-scanner-secret` authentication. It required no migration or
duplicate-scanner deployment. The recorded recovery instruction was to retry
the same pending ad ID rather than upload another copy or manually change
either screening status. Later ordinary-image staging evidence is recorded in
`PRIVATE_PENDING_MEDIA.md`; it does not establish the old ad's final result.

That parser-only deployment note is historical, not the procedure for the
current branch. The claim/lease hardening below adds a new database dependency
and must not be deployed as a function-only change.

`tests/scanner_policy_response.test.mjs` executes the actual handler with mocked
HTTP and database I/O, covering REST envelopes, reasoning-before-text, split
text, review/rejection, refusals, incomplete results, invalid decisions, and
unchanged authentication/terminal-state guards. Hosted retry results must be
verified separately after deployment.

### Pending safety claim/lease hardening

This branch adds
`20260924015352_safety_scan_claim_lease.sql` and corresponding `scan-ad`
changes. They are **not applied or deployed** to staging or production at this
checkpoint. The migration adds a service-only claim, a ten-minute lease,
token-bound failure release, and transactional finalization. Only the worker
holding the current fencing token may reach the paid OpenAI checks or write the
final moderation evidence. A second delivery receives HTTP 202 with
`status: "in_progress"` and `retry_after`; that response is not a terminal
moderation result. A terminated worker can be replaced after its lease becomes
stale. An ordinary handled failure releases its claim immediately.

Deploy this hardening to **adbattle-test only**, in this order:

1. Stop new local staging submissions, disable the safety `scan-ad` Database
   Webhook without changing the duplicate webhook, and drain/inspect its
   delivery log so no queued safety delivery remains. Hold manual scanner
   redeliveries and confirm no invocation of the currently hosted scanner is
   still running; an old worker does not know how to acquire the new lease.
2. Apply the exact contents of
   `20260924015352_safety_scan_claim_lease.sql` once through the Dashboard SQL
   editor. Do not edit or rerun an earlier migration, and do **not** use a
   generic `supabase db push`; the repository contains earlier intentionally
   unhosted AI-video and age-entitlement migrations outside this rollout,
   while hosted migration identifiers have already been remapped. Confirm the
   Dashboard project ref is `nccqnrcdygujulrnwair` before executing the file.
3. Verify `claim_ad_safety_scan`, `finalize_ad_safety_scan`, and
   `record_ad_safety_scan_failure` are executable by `service_role` only, not by
   `PUBLIC`, `anon`, or `authenticated`.
4. Deploy the reviewed `scan-ad` source from the same commit. Preserve
   `verify_jwt=false`; the function continues to authenticate the private
   webhook header itself.
5. Health-check the hardened worker, then re-enable the safety webhook and
   resume submissions/deliveries. Exercise one controlled concurrent retry.
   Exactly one worker should run provider checks; the other should return
   `in_progress` or observe the terminal result. If the owner is terminated,
   redeliver only at or after `retry_after` and verify stale-lease recovery. If
   deployment fails after the migration, keep the webhook and submissions
   paused and roll forward with the hardened worker; do not re-grant the legacy
   unleased RPC to the old worker.

Never deploy the hardened function before the migration: without its RPCs,
every new safety scan fails closed. Finalization retries use the same claim
token and exact payload, so a lost HTTP response can return the committed
result without another transition or duplicate final audit event. Do not clear
lease fields or rewrite scanner evidence manually to force a retry.

The safety `scan-ad` function retains its SHA-256 only as moderation audit
metadata. It does not query other ads, emit duplicate audit stages, or make a
safety decision from image reuse. All exact/perceptual matching and all
duplicate-review decisions belong exclusively to `scan-ad-duplicate` and the
service-only duplicate-review resolution RPC.

## Resolving duplicate review holds

`review_identical` and `review_similar` are review signals, not accusations or
proof of authorship. A service-role reviewer may call
`resolve_ad_duplicate_review(ad_id, decision, reviewer_identity, reason)` with
`clear` or `reject`. A clearance records the decision and changes only the
duplicate state to `passed`; the central gate publishes only if safety has also
passed. A rejection changes the duplicate state to `rejected`, which remains
unpublished without banning the creator or alleging theft.

Every resolution records the matched ad, previous hold state, decision,
reviewer identity, reason, and timestamp in `ad_duplicate_review_decisions`.
The original match reference, scan details, and fingerprint remain unchanged.
Browser roles have no table or RPC access. Each ad can be resolved once; a
repeated action fails rather than overwriting the first audit record.

## Existing-image backfill

Applying the migration does **not** approve or scan anything. Every preexisting
row is marked `image_index_required`. Already-approved rows retain both their
publication status and legacy duplicate result while the separate fingerprint
record remains absent. After storage access is deliberately enabled in a
reviewed staging deployment, an operator with `ADBATTLE_BACKFILL_SECRET` invokes
`scan-ad-duplicate` with `legacy_ad_id`; ordinary authenticated users cannot use this path.
The service-only RPC inserts the fingerprint without recalculating moderation.
Rows whose legacy data has only `image_url` must first be mapped to their verified
owner-namespaced bucket path; do not infer paths from arbitrary URLs.
`ad_image_index_state.ready` defaults to false, so normal submissions fail
closed. A service-role reviewer may record a reasoned exception for an image
that cannot be indexed. The completion RPC refuses to mark the index ready until
every required row has either a fingerprint or a reviewed exception.

## Limitations

dHash is small, explainable, and insensitive to modest resizing/compression,
but it is not authorship evidence. The threshold of 8 is an initial review
threshold, not an automatic-rejection threshold. Crops, screenshots with UI,
large borders, overlays, and changed text can evade it; visually simple shared
templates can collide and create review false positives. The controlled tests
cover representative pixel fixtures, not the variety of real-world artwork.
Reviewers must compare images and may clear matches caused by permission,
common templates, shared source material, or genuinely different ads.

Staging image uploads are enabled by the separately merged local-upload change.
Enabling the browser does not install scanner webhooks, perform the required
image backfill, or establish a successful end-to-end safety review by itself.

## Human review page

The optional [private moderation page](MODERATION_REVIEW.md) adds an explicitly
granted moderator queue and audited safety-hold resolution. It also wraps the
existing duplicate resolution RPC with verified Auth identity, version checks,
and request replay protection. Both screening checks still must pass before
publication. See that guide for the separate migration and staging rollout.

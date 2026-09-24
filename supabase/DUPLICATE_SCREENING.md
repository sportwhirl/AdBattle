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

### Policy response parsing and staging retry

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
`pending` with `OpenAI policy review returned no output_text.` After merging
the parser fix, redeploy only `scan-ad` to **adbattle-test** with its existing
secrets and private `x-adbattle-scanner-secret` authentication. Preserve
`verify_jwt=false`: the function itself authenticates that private webhook
header. No migration or duplicate-scanner deployment is needed for this fix.
Invoke the existing scanner for the same pending ad ID (for the reported
`Staging Upload Test`, `{"ad_id":4}`), using the existing private header.
Do not upload another copy or manually change screening statuses. Check the
new safety audit and both screening states: publication still requires both
checks to pass. A valid review may instead hold or reject the ad. Previously
terminal safety decisions remain skipped, and retrying does not clear them.

`tests/scanner_policy_response.test.mjs` executes the actual handler with mocked
HTTP and database I/O, covering REST envelopes, reasoning-before-text, split
text, review/rejection, refusals, incomplete results, invalid decisions, and
unchanged authentication/terminal-state guards. Hosted retry results must be
verified separately after deployment.

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

## Modest-crop review upgrade

Migration `20260924013032_cropped_image_review.sql` and the matching
`scan-ad-duplicate` worker add a second, versioned comparison **after** the
existing SHA-256 and 64-bit whole-image dHash checks. It compares the whole
submitted image with fixed regions of earlier images, and the whole earlier
image with regions of the submission. Region-to-region matches are excluded.

Version `crop-grid-49-rgb-dhash128-v1` uses 49 regions: width and height each
100%, 90%, or 80%, with each shortened axis anchored at the start, middle, or
end. Each region has a 128-bit horizontal/vertical difference signature, a
3×3 RGB color signature, and luminance contrast. Sampling is fixed at 254,016
pixel reads per decoded image, with existing byte/dimension limits retained.
A candidate must satisfy the aspect, contrast, and bit-diversity gates below,
plus one of two distance/color rules. Migration
`20260924022837_crop_color_supported_review.sql` adds the second rule without
changing descriptors or requiring another backfill:

- **Strict:** 128-bit Hamming distance at most 8 and mean absolute RGB error
  at most 8/255 across the 27 color values. This rule is unchanged.
- **Color-supported:** distance 9–14, mean RGB error at most 5/255, and no
  individual color value differing by more than 24/255. One side must be a
  shortened region; this never broadens whole-to-whole matching.
- region aspect ratios within a factor of 1.05;
- luminance standard deviation at least 18 and 16–112 set hash bits.

The old 64-bit whole-image threshold remains unchanged, and neither rule
allows region-to-region comparisons.

A hit becomes `review_similar`, with `match_method: crop_region` and region,
distance, color-error, and version evidence in the existing scanner details.
The updated matcher also records `matcher_version: crop-review-v2`,
`match_rule: strict` or `color_supported`, and `color_error_max`. Consult
`ad_scan_attempts.details` for the recorded duplicate result if a later safety
scan replaces the ad's general moderation details.
It never automatically rejects an ad or accuses someone of copying. Both
safety and duplicate clearance plus verified-byte publication are still needed.
The already approved cropped ad and previous review decisions are not rescanned
or reset by this migration/backfill.

The actual staging original/crop pair previously had dHash distance 27/64;
the new full-to-region comparison has distance 8/128 and color error 28/27
(about 1.04). The regression fixture stores only their source SHA-256 values
and descriptors, not image bytes or account data. Tests also cover resized
synthetic crops and unrelated/low-detail/color/aspect negative controls.
This is limited evidence, not a measured production false-positive rate.
The later staging `crop test` (ad #11, 2195×1906) exposed a gap between sampled
sizes: the closest region of original #2 differs by 13/128 bits, color-error
sum 110/27 (about 4.07), and maximum individual color error 16. The original
rule returned no match. The color-supported rule holds that pair for review
in either upload order, without relying on the previously indexed crop #7.
The regression reproduces the old miss before applying the migration and
checks the new scan RPC does not enqueue publication, even after safety passes.
Negative controls include three unrelated stored staging creatives, generated
textures, color/distance boundaries, aspect, contrast, and bit diversity.
This fallback can increase review volume; it is not proof of copying.
Some off-grid crops, large crops, rotations, overlays, borders, and heavily edited artwork
can still evade this bounded matcher. Existing dHash collisions remain possible.

### Follow-up rollout for an already backfilled project

After review and merge, apply only
`20260924022837_crop_color_supported_review.sql` to **adbattle-test**. It
replaces the private matching helper and preserves its permissions. No Edge
Function redeploy, new fingerprint version, or repeated backfill is needed.
It does not change existing ads, fingerprints, audit rows, or publication
queues. In particular, the already approved `crop test` remains approved.

Before another upload, use this read-only check to compare the existing
missed crop directly to its original (IDs below are staging fixtures):

```sql
select duplicate_private.crop_match(c.crop_fingerprint, o.crop_fingerprint) as match
from public.ad_image_fingerprints c
join public.ad_image_fingerprints o on o.ad_id = 2
where c.ad_id = 11;
```

Expect `match_rule: color_supported`, distance 13, submitted region 0,
matched region 42, and color-error sum 110. This proves the updated matcher,
not a new upload flow: re-uploading identical bytes will exercise exact SHA
matching, and a nearly identical upload may match ad #11 through the older
whole-image path. Inspect the scan attempt's `match_method` and `crop_match`
before claiming the crop fallback was exercised by a new browser submission.

### Staging rollout after review and merge

Use only **adbattle-test** (`nccqnrcdygujulrnwair`). This change does not itself
apply a hosted migration, deploy a function, invoke a scanner, or alter ads.

1. Apply only the new crop migration after the existing private-image and
   publication-hash migrations. Existing published ads remain available, but
   pending scans intentionally stop while old descriptors are missing. Old
   worker calls for pending ads get `CROP_SCANNER_UPGRADE_REQUIRED`.
2. Redeploy **scan-ad-duplicate**, retaining `verify_jwt=false`, its existing
   private webhook/backfill secrets, and CORS configuration. Include the new
   `_shared/crop-fingerprint.ts` in a Dashboard deployment package.
3. List missing descriptors with this read-only SQL:

   ```sql
   select f.ad_id, a.image_publication_state
   from public.ad_image_fingerprints f join public.ads a on a.id=f.ad_id
   where f.crop_fingerprint is null order by f.ad_id;
   ```

4. For each returned ID, invoke the existing function with JSON
   `{"crop_backfill_ad_id": 2}` (replace `2` with that ID) and the existing private
   `x-adbattle-backfill-secret` header. Never paste the secret into chat, browser
   code, SQL, or a committed file. The worker reloads the owner and source path;
   `legacy_public` reads the original from `ad-images`, while all modern images
   read their untouched original from `ad-pending-images`, even if now public.
   The RPC requires the exact already-indexed SHA-256. An identical replay is
   safe; different bytes or a changed descriptor fail. A missing/unavailable
   original requires investigation; do not fabricate a descriptor, delete the
   old fingerprint, or loosen the readiness check.
5. Require zero missing descriptors and `ad_image_index_state.ready=true`.
   No separate readiness switch bypasses missing crops. New legacy indexing
   also writes crop descriptors; if its second call fails, normal scans stay
   blocked until that row is backfilled.
6. Retry only still-pending duplicate scans using their existing INSERT webhook
   payloads/private header. Do not reset completed statuses. Use a new staging
   test submission for the modest crop; confirm `review_similar`, the matched
   original, both reviewer previews, and no public URL while held. Record a
   human review, then verify the private-publication gate follows that decision.

Backfill is metadata-only: it does not call moderation refresh, insert another
review decision, or enqueue publication. The shared index lock serializes
backfill/scanning; the new RPC takes it before locking the ad, matching legacy
backfill lock order. Browser roles cannot read descriptors or call these RPCs.
A partial index supports the readiness check; regional matching still scans
all prior descriptors, with at most 97 comparisons per candidate. Evaluate
latency on a representative corpus before increasing production volume.

To stop a faulty rollout, pause the duplicate-scanner webhook and keep pending
ads private. Do not restore the old pending-scan RPC as a bypass, remove review
history, or disable publication checks. Diagnose and deploy a reviewed fix.

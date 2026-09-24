# Private pending ad images

This document describes the private-media contract and the **test project**
rollout. Production has not received this change.

## Publication contract

1. Browser uploads a JPEG or PNG (at most 10 MiB) into private
   `ad-pending-images/<owner UUID>/<random UUID>.<ext>` with `upsert:false`.
   The ad INSERT stores that path and an empty `image_url`. Database triggers
   overwrite caller-supplied scan/publication status, URLs and hashes.
2. Independent safety and duplicate webhook scanners load the same private
   object under the authoritative ad owner. MIME metadata, magic bytes,
   dimensions (at most 4096 pixels per edge / 16.8 million pixels total),
   byte length, and exact hashes are checked. Both scans can finish in either
   order. They cannot by themselves set `moderation_status='approved'`.
3. Whichever scan passes second inserts one durable queue row. A webhook on
   `ad_image_publication_queue` can invoke `publish-ad-image` with
   `{"record":{"ad_id":123}}` and secret header
   `x-adbattle-publisher-secret`. The worker's `{"action":"sweep"}` route
   processes ten queued rows per call, including interrupted `publishing` rows.
   Failed jobs receive increasing retry delays, so repeated failures do not
   permanently occupy the first ten slots ahead of fresh work.
4. A service-only claim checks that both scan hashes agree. The worker
   re-downloads private bytes and checks their hash before upload. It uploads
   a deterministic content-addressed path to public `ad-images` without
   upsert, downloads that public copy, and checks the same hash before a
   service-only completion RPC sets the URL and approved status. A retry may
   encounter the same immutable object and verify it. An uncertain failure
   leaves the row pending and queued. No browser can mutate either bucket's
   scanned objects or write to the public bucket through old broad policies.
5. Owner RPCs return no public URL for pending ads. The browser requests a
   60-second signed preview from `pending-ad-previews`, which verifies the
   bearer token, owner ID and still-pending state. Held and rejected items
   display a neutral placeholder. Approved legacy ads retain their old URL.

The staging AI route creates a canonical JPEG in the private draft bucket.
`submit-ai-ad` verifies that object and copies its exact bytes into this
private pending bucket at `<owner UUID>/<AI request UUID>.jpg`. If the upload
response is lost or reports an error, the service continues only after a fresh
download proves the deterministic object has the exact canonical bytes and
SHA-256. The ad carries the canonical SHA-256, stamped by the
database from the completed owner draft; direct browser AI-origin INSERTs
fail. Publication requires this hash to match both scanners and the fresh
private bytes. This route still requires the separate adult staging claim and
server post enable flag. See `AI_IMAGE_DRAFTS.md`.

## Test-project rollout snapshot (2026-09-24)

Project `nccqnrcdygujulrnwair` (`adbattle-test`) has the four initial image
migrations in order: `20260923162944_ai_image_draft_quota.sql`,
`20260923170000_private_pending_images.sql`,
`20260923170351_openai_image_draft_model.sql`, and
`20260923180001_ai_canonical_post.sql`. Hosted migration history records them
as `20260923223756`, `20260923223804`, `20260923223816`, and
`20260923223823`, respectively. The forward hash-guard migration
`20260924012243_image_publication_hash_guard.sql` was applied as hosted
`20260924012526`. It makes missing fingerprint or moderation hashes fail
completion, including idempotent retries. The private `ad-pending-images`
bucket exists.

This branch also contains two forward hardening migrations:
`20260924015116_harden_ai_draft_storage.sql` adds restrictive policies for the
private AI draft bucket, and
`20260924015352_safety_scan_claim_lease.sql` adds service-only safety-scan
claim, lease, failure-release, and finalization RPCs. Neither migration is
applied to staging or production at this checkpoint, and the corresponding
hardened Edge Function source is not hosted. Do not treat local tests or the
files' presence in this branch as deployment evidence.

Before the migrations, the two unapproved staging images for ads #5 and #6
were copied to the private bucket at their original paths and verified against
their source SHA-256 values. The two public originals were then removed using
the Storage API; their `image_url` fields are now empty strings. Ad #5 remains
`pending_scan` with `duplicate_same_creator`; ad #6 remains `rejected`.
Approved public images were preserved.

Hosted test-project functions are active: `scan-ad` v14 and
`scan-ad-duplicate` v13 (`verify_jwt=false`), `publish-ad-image` v4
(`verify_jwt=false`), `pending-ad-previews` v9 (`verify_jwt=true`),
`generate-ai-image` v9 and `submit-ai-ad` v2 (`verify_jwt=true`). The existing
safety and duplicate scan webhooks remain active. The dedicated publisher
secret is stored in staging Vault and Edge Secrets. The Dashboard saved one
terminal newline with the Edge value, so the worker discards exactly that
newline from its configured value before comparing the HTTP header. A
Vault-backed queue INSERT wakeup trigger and every-minute sweep cron were
installed as hosted migration `20260924001553`. A secret-authenticated empty
sweep returned HTTP 200 (`completed:0`, `deferred:0`), while the same request
without the secret returned 401. The queue is empty. AI generation and posting
server flags and the browser `aiImageDrafts` capability remain off. In the
current branch, local staging independently enables `aiProvenanceReads` and
`privateMediaPipeline`; production keeps all three capabilities off. This is
not an AI generation test or an all-ages release.

The first authenticated posting smoke on 2026-09-24 covered both outcomes.
Ad #9 (`ooga`) passed duplicate screening but was held for manual safety
review of health efficacy claims in its image. Its source stayed private,
with no public URL, public object, or publication queue row. Ad #10
(`neutral screenshot`) passed both scanners and was approved about 6.1 seconds
after submission. Its 66,258-byte private source and public copy both exist;
the safety, duplicate-fingerprint, and recorded published SHA-256 values agree,
the public URL names the published path, and the queue row was consumed.
The publisher POST returned HTTP 200. This verifies the ordinary image hold
and success paths in hosted staging; it does not exercise paid AI generation,
both possible scan completion orders, or fault/retry behavior.

An anonymous HTTP call to `get_public_ads_with_ai` returned six approved ads:
#10 was present and held #9 absent. This verifies the public gallery RPC, not
browser rendering. For #9, the private bucket has no public copy or URL;
read-only RLS probes showed its pending object to the owner, but not to an
anonymous or other authenticated user. An anonymous HTTP preview request was
rejected with 401. The deployed preview code checks verified Auth identity and
ownership before signing a 60-second URL; a live owner/stranger preview pair
has not yet been exercised.

Live Storage policy inspection showed restrictive RLS rules deny ordinary
clients INSERT, UPDATE, and DELETE on public `ad-images`, despite an older
authenticated owner policy. Private `ad-pending-images` permits owner-scoped
uploads and reads, while client updates and deletes are blocked. A live
upload-denial HTTP request has not yet been exercised.

Legacy approved ad #3 remains in both anonymous gallery RPCs; its public PNG
URL returned HTTP 200 with the expected 728,890-byte length. The active
staging page at that earlier checkpoint selected `get_public_ads` because the
creation switch also controlled provenance reads. That RPC returned six ads,
including approved #3 and #10 and excluding held #9. The current branch fixes
that coupling: local staging selects `get_public_ads_with_ai` through
`aiProvenanceReads=true` even while `aiImageDrafts=false`, so disabling creation
does not remove an existing AI disclosure. These are API and Storage checks,
not a browser-rendering result for the updated branch. The available database
HTTP proxy permits only JSON POST bodies, so its Storage upload attempt failed
MIME validation before it could test the RLS write denial.

Publisher v4 checks the exact public bytes after every upload result, including
an unfamiliar conflict or uncertain response. Missing or mismatched copies
defer publication. The hosted function's files matched the reviewed source;
a secret-authenticated empty sweep returned 200 (`completed:0`, `deferred:0`)
and a request without the publisher secret returned 401. The queue stayed
empty, and ads #3, #9, and #10 retained their expected states. At that
pre-hardening checkpoint, local tests passed 235/235, including a regression
that demonstrates the prior nullable hash bypass. After integrating the current
production main on 2026-09-24, the complete local suites passed 305/305
JavaScript tests and 40/40 Python tests. Those are local results; they do not
claim that the unhosted hardening migrations or functions ran in staging.

On 2026-09-24, an earlier temporary staging-only, secret-gated fixed-fixture
probe ran the hosted JPEG processor with a 1280×720 pixel-art input and a
1024×1024 smooth-style input. It produced a 6,927-byte 640×360 JPEG in 56 ms
and an 11,827-byte 640×640 JPEG in 95 ms. Both decoded and met the 500 KiB
bound. That checkpoint recorded bundle SHA-256
`cf16ccf50ddd0342606c8faf5c03173dfb44289d5a3e8dcf6468383c3051661c`.
Those codec measurements and hash remain historical; the later source-size
checkpoint superseded them, so the hash must not be used as a current
integrity value.

The later hosted fixture smoke documented in `AI_IMAGE_DRAFTS.md` exercised the
current 1088×608 and 816×816 sources, preserved both wide-image edges, and then
verified the restored `generate-ai-image` v9 files with JWT verification on.
The endpoint returned 503 with generation disabled and 401 without
authorization. This proves the hosted codec path for simple fixtures, not a
provider response, high-entropy image, end-to-end AI post, or the pending
uncertain-commit hardening.

## Remaining staging steps

1. Keep production public posting unchanged:
   `privateMediaPipeline=false`, `aiProvenanceReads=false`, and
   `aiImageDrafts=false`. Production continues using its existing public
   `ad-images` upload path until the full private-media backend is deployed and
   verified there first. Never publish a frontend with
   `privateMediaPipeline=true` against a project that lacks the private bucket,
   migrations, scanners, preview function, publisher, webhook, and sweep.
2. Quiesce new staging uploads, disable the safety `scan-ad` Database Webhook
   without changing the duplicate webhook, and drain/inspect its delivery log
   so no queued safety delivery remains. Also hold manual safety redeliveries
   and confirm no hosted `scan-ad` v14 invocation remains active. Apply
   `20260924015116_harden_ai_draft_storage.sql` once, followed by
   `20260924015352_safety_scan_claim_lease.sql`. Verify browser denial for all
   four AI draft Storage operations and verify the new safety RPCs are
   service-role-only. Neither migration is hosted yet. Apply only the exact
   contents of those two reviewed files, one at a time, through the Dashboard
   SQL editor after confirming project ref `nccqnrcdygujulrnwair`. Do **not**
   run a generic `supabase db push`: hosted migration IDs are already remapped,
   and the earlier local `20260923163511_ai_video_draft_jobs.sql` and
   `20260924013505_adult_age_entitlement_foundation.sql` are intentionally
   outside this rollout.
3. Deploy the hardened `generate-ai-image` and `submit-ai-ad` with
   `verify_jwt=true`, then deploy hardened `scan-ad` with `verify_jwt=false`
   from the same reviewed commit. The safety migration must precede the new
   scanner source. Keep both server AI enable flags and `aiImageDrafts` off
   during deployment. Verify authenticated calls receive the disabled 503
   response without a paid call, and separately verify the hosted JWT gateway
   rejects missing/invalid authorization with 401. Health-check the new scanner
   before re-enabling the safety webhook and submissions. If deployment fails
   after the migration, keep them paused and roll forward with the hardened
   worker; do not restore the legacy unleased RPC or resume the old worker.
4. Run the local staging frontend only against project
   `nccqnrcdygujulrnwair`. Confirm `privateMediaPipeline=true` routes ordinary
   uploads to `ad-pending-images`, `aiProvenanceReads=true` selects the
   provenance-aware RPCs, and production still routes to `ad-images` without
   requesting pending previews. Verify public-bucket write denial over HTTP and
   owner/stranger signed previews using authenticated clients.
5. The installed staging-only `operations/staging_image_publication_dispatch.sql`
   reads the Vault secret at call time. Do not reapply it or apply it to
   production. Keep the existing safety/duplicate webhooks in place. The
   worker reads only `ad_id` from a wakeup and reloads the authoritative row.
6. Monitor HTTP delivery as well as the scheduled SQL run;
   `cron.job_run_details` success alone proves only SQL dispatch. Alert if
   queue age exceeds several minutes, the worker repeatedly returns 503, or
   `publishing` becomes stuck. Test the alternate scan completion order,
   changed private bytes, retry after upload, concurrent safety deliveries,
   stale-lease recovery, and lost database responses. Test Seed/Support on an
   approved staging ad to check wallet behavior.
7. Before an approved adult staging AI test, verify provider access, provision
   an adult test claim and the OpenAI key, and enable the separate server image
   generation and posting flags. Keep `aiImageDrafts=false` until the backend
   flow works; do not disable `aiProvenanceReads` or `privateMediaPipeline` as a
   substitute for that creation kill switch. After the direct backend smoke and
   scanner/publication checks pass, make a separate reviewed staging-only
   `aiImageDrafts=true` change, verify production remains false, run one browser
   end-to-end test, and disable the staging switch again on any failure. See
   `AI_IMAGE_DRAFTS.md`.

Do not open all-ages creation on the strength of this media gate alone. Age
assurance, parent consent, payments and the separate youth release gates in
`docs/YOUTH_ACCESS_PLAN.md` still apply.

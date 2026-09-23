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
private pending bucket. The ad carries the canonical SHA-256, stamped by the
database from the completed owner draft; direct browser AI-origin INSERTs
fail. Publication requires this hash to match both scanners and the fresh
private bytes. This route still requires the separate adult staging claim and
server post enable flag. See `AI_IMAGE_DRAFTS.md`.

## Test-project rollout snapshot (2026-09-23)

Project `nccqnrcdygujulrnwair` (`adbattle-test`) has the four image
migrations in order: `20260923162944_ai_image_draft_quota.sql`,
`20260923170000_private_pending_images.sql`,
`20260923170351_openai_image_draft_model.sql`, and
`20260923180000_ai_canonical_post.sql`. Hosted migration history records them
as `20260923223756`, `20260923223804`, `20260923223816`, and
`20260923223823`, respectively. The private `ad-pending-images` bucket exists.

Before the migrations, the two unapproved staging images for ads #5 and #6
were copied to the private bucket at their original paths and verified against
their source SHA-256 values. The two public originals were then removed using
the Storage API; their `image_url` fields are now empty strings. Ad #5 remains
`pending_scan` with `duplicate_same_creator`; ad #6 remains `rejected`.
Approved public images were preserved.

Hosted test-project functions are active: `scan-ad` v13 and
`scan-ad-duplicate` v12 (`verify_jwt=false`), `publish-ad-image` v1
(`verify_jwt=false`), `pending-ad-previews` v8 (`verify_jwt=true`), and
`generate-ai-image` and `submit-ai-ad` v1 (`verify_jwt=true`). The existing
safety and duplicate scan webhooks remain active. A dedicated 64-character
publisher secret was generated into staging Vault without displaying its value;
the matching Edge secret, queue INSERT trigger, and publication sweep cron are
still absent. The queue is empty. AI generation and posting feature flags
remain off. This is not an end-to-end hosted publication test or an all-ages
release.

## Remaining staging steps

1. Keep public posting disabled. Verify private-bucket access, public-bucket
   write denial, and owner/stranger previews using anon and authenticated
   clients. Confirm the staging frontend points only to the test project.
2. Set `ADBATTLE_IMAGE_PUBLISHER_SECRET` in the publisher Edge Function to the
   existing staging Vault value named `adbattle_image_publisher_secret`. The
   review-only `operations/staging_image_publication_dispatch.sql` uses that Vault secret
   at call time for an INSERT wakeup on the durable queue and a once-per-minute
   sweep. It is hard-coded to the **test project** and must not be applied to
   production. Keep the existing safety/duplicate webhooks in place. The
   worker reads only `ad_id` from a wakeup and reloads the authoritative row.
3. Check that an empty sweep reaches `publish-ad-image` with HTTP 200;
   `cron.job_run_details` success alone proves only SQL dispatch. Alert if
   queue age exceeds several minutes, the worker repeatedly returns 503, or
   `publishing` becomes stuck. Test both scan completion orders, a review
   hold, changed private bytes, retry after upload, owner/stranger previews,
   public-bucket write denial, and a legacy approved ad. Test Seed/Support on
   an approved staging ad to check wallet behavior.
4. Before an approved adult staging AI test, verify the hosted JPEG processor
   and provider access, provision an adult test claim and the OpenAI key, and
   enable the separate server image generation and posting flags. Keep the
   browser flag off until the staging flow works. See `AI_IMAGE_DRAFTS.md`.

Do not open all-ages creation on the strength of this media gate alone. Age
assurance, parent consent, payments and the separate youth release gates in
`docs/YOUTH_ACCESS_PLAN.md` still apply.

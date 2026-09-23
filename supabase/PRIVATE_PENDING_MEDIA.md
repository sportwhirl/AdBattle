# Private pending ad images

This change is **code and migration only**. No hosted Supabase migration,
bucket, webhook, schedule or Edge Function deployment was performed.

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

## Staging rollout preconditions and order

1. Keep public posting disabled during rollout. Inventory `storage.objects`
   in `ad-images` against approved ad rows, including orphaned uploads. Audit
   `pg_policies` for `storage.objects`, especially broad anon/authenticated
   policies; the migration adds restrictive policies for both roles. Check
   existing `ads` rows with public URLs and nonapproved status. Use the
   **Storage API**, not direct writes to `storage.objects`, to remove or
   quarantine unreviewed/orphaned public files. Clear unsafe old URLs and
   record the disposition of their rows. The migration refuses to apply until
   unapproved public rows and orphaned public objects are gone.
2. Confirm `ad-images` exists and is public, and no signed/public URLs for
   pending media remain cached on CDN. Apply the dated migration to the
   **staging project only**, followed by the canonical AI post migration if
   AI drafts are enabled. It creates private bucket, policies, queue and
   service-only RPCs. Verify actual bucket and RLS behavior with an anon and
   authenticated account. The migration checks the bucket settings and
   blocks if they differ.
3. Deploy `scan-ad`, `scan-ad-duplicate`, `publish-ad-image` and
   `pending-ad-previews` together with the updated frontend. Configure a
   separate 32+ character `ADBATTLE_IMAGE_PUBLISHER_SECRET` for the worker.
   Keep existing authenticated safety/duplicate webhooks in place. Add a
   Database Webhook on `public.ad_image_publication_queue` INSERT to call
   `publish-ad-image` with the publisher secret. The worker reads only the
   `ad_id` from the webhook; it reloads the row from the database.
   For adult-only AI staging tests, also deploy `generate-ai-image` and
   `submit-ai-ad` with JWT verification and the separate
   `ADBATTLE_AI_IMAGE_POST_ENABLED=true` server flag after validating the
   server JPEG processor in hosted staging.
4. Configure an authenticated scheduled POST to `publish-ad-image` with
   `{"action":"sweep"}` and that secret at least once per minute. Each call
   processes up to ten queued rows. Alert if queue age exceeds several
   minutes, worker returns 503 repeatedly, or `publishing` is stuck. Before
   opening posting, test safety-first and duplicate-first outcomes, a review
   hold, a changed private object, retry after upload, owner/stranger
   previews, public bucket write denial, and a legacy approved ad. Run
   a test Seed/Support on an approved ad to confirm wallet behavior.

Do not open all-ages creation on the strength of this media gate alone. Age
assurance, parent consent, payments and the separate youth release gates in
`docs/YOUTH_ACCESS_PLAN.md` still apply.

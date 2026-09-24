# Staging AI image drafts

This integration is limited to the adbattle-test project
(nccqnrcdygujulrnwair) at http://localhost:8000. The local staging frontend
flag `aiImageDrafts` and the staging server generation/posting flags are on
for the restricted adult test account. All production AI-creation flags remain
off. The
read-only AI provenance and private-media capabilities are separate controls;
turning creation off must not erase an AI disclosure from an already-published
ad or send staging uploads back to the public `ad-images` path.

| Frontend capability | Local staging | Production | Purpose |
| --- | --- | --- | --- |
| `aiImageDrafts` | `true` | `false` | Shows and invokes AI image creation. |
| `aiProvenanceReads` | `true` | `false` | Selects provenance-aware gallery RPCs independently of creation. |
| `privateMediaPipeline` | `true` | `false` | Sends ordinary staging uploads through private pending storage. |

The Edge Function also requires the exact test project URL, origin, and
ADBATTLE_AI_IMAGE_ENABLED=true. Posting additionally requires
ADBATTLE_AI_IMAGE_POST_ENABLED=true. Do not deploy this to the public
site before deciding a generation budget and completing the separate youth
access gates. The server also requires an admin-owned
`app_metadata.ai_image_adult_test_approved` claim on the verified Auth user.
Only manually approved adult staging testers should receive that claim. A
browser checkbox or user-editable metadata does not qualify. This staging
claim does not enable public youth access. A future all-ages release needs
server-verified age and guardian eligibility; OpenAI's under-18 guidance
requires approved Zero Data Retention before processing personal data of
children under 13, alongside the applicable parental consent path.

## Flow and limits

1. An approved adult staging tester enters a prompt of at most 400 characters
   and a 1:1 or 16:9 shape. Pixel art, flat illustration, simple 3D, and
   loose hand-drawn presets are optional directions; the default "Your own
   style" lets the creator describe any policy-compliant style in the prompt,
   including detailed or photorealistic fictional scenes. The model receives
   readability guidance, while the enforced size/byte limits apply to the
   displayed result. A UUID is saved locally before the request so a lost
   response can be recovered with the same ID and prompt.
2. A service-only database RPC atomically reserves a request before any model
   call. It caps generation at 3 requests per creator per UTC day and 30
   globally, with one active request per creator. Server settings
   ADBATTLE_AI_IMAGE_USER_DAY_LIMIT and ADBATTLE_AI_IMAGE_GLOBAL_DAY_LIMIT may
   lower those caps, not raise them. Failed and uncertain outcomes consume
   quota. A reserved request is never sent to the image model twice.
3. The existing OpenAI ad-policy model checks the proposed image prompt before
   image generation. Held, rejected, malformed, or unavailable policy results
   fail closed and do not generate. This is a preliminary text check; the
   posted image still must pass the existing image safety and duplicate scans.
4. The server calls OpenAI `POST /v1/images/generations` with
   `gpt-image-2.5-flare`, `quality=low`, `n=1`, JPEG output, provider moderation
   at `auto`, and no image or reference input. The square source request is
   816×816 (665,856 pixels); the near-16:9 source is 1088×608 (661,504
   pixels). Both satisfy the model's 16-pixel dimension increments and
   655,360-pixel minimum. An exact 16:9 source at this minimum would need
   1280×720, so the landscape canonical resize preserves the whole frame
   while adjusting its aspect by about 0.66%. The server validates the
   raw `data[0].b64_json`, expected dimensions, JPEG markers, and an 8 MiB
   byte ceiling. It never sends the browser's raw provider settings.
5. The unmodified provider image is saved privately under the owner's path.
   The server also decodes and resizes it to a canonical 640×640 or 640×360
   JPEG at most 500 KiB. Pixel art uses nearest-neighbor resizing; other
   styles use a bounded bilinear resize. Both objects and their SHA-256 hashes are stored
   in the private ai-image-drafts bucket. The creator previews only the
   canonical image through a ten-minute signed URL. A completed request can
   receive another signed URL without another model call. Responses containing
   that private URL use `Cache-Control: private, no-store`.
6. The creator chooses Use this image or Discard draft. Generation never posts
   an ad. Explicit submission sends only the source request ID, title, and
   caption to the staging-only submit-ai-ad function. The server verifies the
   private JPEG's hash, format, dimensions, and byte count before copying its
   exact bytes to the private ad-pending-images bucket at the deterministic
   `<owner>/<request ID>.jpg` path. The safety and
   duplicate scanners inspect those bytes; publication compares both scanner
   hashes and a fresh private download against the canonical hash before
   service-only copying to the public bucket.

Only a service-role insert can attach an AI draft to an ad. The ad trigger
checks the completed owner draft, stamps its immutable canonical hash and
ai_generated provenance, and refuses browser-supplied AI source IDs. The
publisher refuses mismatched scan or source hashes before public upload. The
fixed-column read RPCs expose a Made with AdBattle AI badge on public and owner
cards; existing RPC signatures remain intact. Users may also use other AI
tools outside AdBattle without this badge.

No wallet, Support, creator, or promotion funds are debited by generation.
The private source has no AdBattle watermark. Public export/watermark behavior
remains a separate media pipeline.

## Staging setup and review

The migrations `20260923162944_ai_image_draft_quota.sql`,
`20260923170000_private_pending_images.sql`,
`20260923170351_openai_image_draft_model.sql`, and
`20260923180001_ai_canonical_post.sql` were applied in timestamp order to
adbattle-test on 2026-09-23, after the private-media cleanup preflight passed.
The first creates a private 8 MiB JPEG/PNG bucket, a request table with RLS
and no browser grants, a service-only reservation RPC, and the provenance
trigger/read RPCs. The model migration switches the default model for new
reservation rows to Flare without rewriting existing draft history. The
canonical-post migration adds the byte binding and a backoff queue for
publication retries. Older completed draft rows without canonical fields
cannot be posted; make a new draft rather than silently trusting the browser.
The private buckets now exist. Merely setting a bucket to `public=false` does
not override a broad `storage.objects` RLS policy. The forward migration
`20260924015116_harden_ai_draft_storage.sql` in this branch adds restrictive
SELECT, INSERT, UPDATE, and DELETE policies so browser roles cannot reach
`ai-image-drafts` even if an older permissive policy also applies. That
migration was applied to adbattle-test on 2026-09-24 and remains unapplied to
production.

The test project has `generate-ai-image` and `submit-ai-ad` active with JWT
verification on; the image scanners,
publisher, and owner-preview functions are also deployed (see
`PRIVATE_PENDING_MEDIA.md`). Their deployment alone does not turn on AI
generation or posting. The hosted function now requests 816×816 or 1088×608
sources. The staging flags were enabled only after the private-storage, JWT,
entitlement, quota, and disabled-path checks passed. The
publisher's matching secret, queue wakeup,
and scheduled sweep are installed. Staging AI ad 15 completed generation,
submission, both hosted scans, canonical-hash publication, and the public
AI-provenance read path on 2026-09-24.
Prefer deploying from the reviewed repository checkout so the function bundle
resolves every relative import. If the Dashboard editor is used instead,
`generate-ai-image` requires `_shared/http.ts` and
`_shared/storage-scan-policy.ts`; `submit-ai-ad` requires those two files plus
`_shared/image-fingerprint.ts`; and `scan-ad` requires
`_shared/storage-scan-policy.ts`. A function whose shared files are missing is
not a successful deployment.

Before the server flags were enabled,
`20260924015116_harden_ai_draft_storage.sql` was applied once to
**adbattle-test**. Both `anon` and `authenticated` were verified unable to
SELECT, INSERT, UPDATE, or DELETE draft-bucket objects, while `service_role`
retained access. The hardened `generate-ai-image` and `submit-ai-ad` sources
from the reviewed merge commit were deployed with JWT verification enabled.
An authenticated disabled-path request returned 503 without contacting the
provider, and the hosted JWT gateway independently rejected a request without
valid authorization with 401. The repository still contains intentionally
unhosted AI-video and future age-entitlement migrations that are not part of
this rollout; do **not** use a generic `supabase db push`.

Set `OPENAI_API_KEY` as an Edge Function secret and set
`ADBATTLE_AI_IMAGE_ENABLED=true` and `ADBATTLE_AI_IMAGE_POST_ENABLED=true`
only in adbattle-test. The same server key is
used for prompt policy screening and image generation. Provision the adult
test approval claim through a privileged Auth administrator after confirming
the tester's eligibility; missing or false claims fail before quota
reservation. Never save secrets in index.html, frontend-config.js, committed
config, URLs, or logs. The existing local staging launcher uses the test
publishable key. Test with an approved adult signed-in account: generate one
harmless image, inspect the private bucket and quota row, review and select
the draft, submit it, and confirm the two scanner statuses and public badge.
First perform the authenticated backend smoke with the browser creation switch
still off. Once generation, submission, both scanners, and publication pass,
make a separate reviewed staging-only change setting `aiImageDrafts=true`,
confirm the production value remains false, and run one browser end-to-end
draft/review/submit test. Turn the staging switch back off if any check fails.
Automated tests mock both model calls and run the real quota SQL locally; they
make no paid generation request. Smaller source dimensions reduce local decode
work and may reduce transfer bytes, but they do not guarantee a proportional
drop in provider tokens, charges, or generation time. Capture the real image
response's `usage`, elapsed time, and billed amount for representative prompts
and both shapes before settling the budget or widening access. OpenAI account
access to Flare, any organization verification, actual output shape/latency,
and provider usage or invoice cost must be checked in restricted staging.

The browser displays the signed private canonical URL directly; it never
compresses or uploads the AI post bytes. A hosted fixed-fixture smoke ran the
pinned decoder/encoder on the new 1088×608 pixel-art and 816×816 smooth
inputs. It produced decodable 640×360 and 640×640 JPEGs of 9,703 and 11,827
bytes in 109 and 143 ms, respectively. The wide fixture checks that both
colored source edges survive the resize. The temporary probe was removed and
the reviewed real-function source was deployed with JWT verification on; the
endpoint returned 503 while generation was disabled. A later restricted
staging smoke generated one 640×640 canonical JPEG (43,776 bytes) with
`gpt-image-2.5-flare`, then published it only after one safety-provider check
and one duplicate scan. This establishes the complete hosted flow for that
single benign fixture, not representative cost, latency, or behavior across
high-entropy images. If preview expires, the saved
request ID can obtain a fresh signed URL without another image call.

After a lost generation response, keep the saved request ID and prompt. The
hardened function re-reads the authoritative request row after an uncertain
completion write. A matching completed row returns the saved result; an
unknown outcome returns 503 but retains both private objects and does not mark
the request failed. Retrying the same request ID must never buy a second model
output. A three-minute abandoned reservation becomes unknown, remains counted
against quota, and cannot be sent to the image model again.

Both generated draft paths are deterministic. If Storage reports an upload
error or throws after committing either object, the function downloads that
path and continues only when its SHA-256 and bytes exactly match the object it
just tried to store. A missing, unreadable, or different object fails closed
and is not overwritten or deleted. A definitively failed reservation replay
returns `GENERATION_FAILED` with HTTP 409, so the browser can offer an explicit
discard/reset rather than presenting it as an uncertain paid outcome. A live
request returns that terminal error only after the failure-state write is
acknowledged or an authoritative read proves it committed; otherwise it
returns `GENERATION_OUTCOME_UNCERTAIN` and the browser retains the request ID.

`submit-ai-ad` likewise re-reads the authoritative ad after an uncertain INSERT.
The pending copy uses the deterministic `<owner>/<request ID>.jpg` path. An
upload error is accepted only if a service read proves the existing bytes and
hash exactly match the canonical draft, so retries cannot create a second
copy. A replay succeeds only when owner, path, normalized title, and normalized
caption match the immutable ad; changed submission data returns
`SUBMISSION_CONFLICT`. An unavailable, empty, or otherwise inconclusive read
retains the object for reconciliation because postgrest-js may surface a
transport failure as an error object rather than a thrown exception. Do not
manually delete objects associated with an uncertain request. Draft and
pending Storage objects do not yet have automatic retention cleanup; any later
cleanup must retain enough request/ad history for idempotency and prove an
object is unreferenced before removal.

OpenAI references: https://developers.openai.com/api/docs/models/gpt-image-2.5-flare ,
https://developers.openai.com/api/docs/guides/image-generation ,
https://developers.openai.com/api/reference/resources/images/methods/generate/ ,
https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance ,
and https://developers.openai.com/api/docs/guides/your-data .

# Staging AI image drafts

This integration is limited to the adbattle-test project
(nccqnrcdygujulrnwair) at http://localhost:8000. The public frontend feature
flag and the server generation/posting flags are off. The Edge Function also
requires the exact test project URL, origin, and
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
The deployed route code also checks a service-only adult entitlement for the
verified Auth user: `ai_image_generate` before reservation and signed draft
delivery, and the distinct `ai_image_submit` scope before any draft read or ad
write. Both use the fixed `openai_images` provider route and fail closed when
the RPC is missing, false, or unavailable. The age migration is not yet applied
to staging, and no assessment or grant has been issued.

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
   receive another signed URL without another model call.
6. The creator chooses Use this image or Discard draft. Generation never posts
   an ad. Explicit submission sends only the source request ID, title, and
   caption to the staging-only submit-ai-ad function. The server verifies the
   private JPEG's hash, format, dimensions, and byte count before copying its
   exact bytes to the private ad-pending-images bucket. The safety and
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
`20260923180000_ai_canonical_post.sql` were applied in timestamp order to
adbattle-test on 2026-09-23, after the private-media cleanup preflight passed.
The first creates a private 8 MiB JPEG/PNG bucket, a request table with RLS
and no browser grants, a service-only reservation RPC, and the provenance
trigger/read RPCs. The model migration switches the default model for new
reservation rows to Flare without rewriting existing draft history. The
canonical-post migration adds the byte binding and a backoff queue for
publication retries. Older completed draft rows without canonical fields
cannot be posted; make a new draft rather than silently trusting the browser.
The private buckets now exist. The test project has `generate-ai-image` v10 and
`submit-ai-ad` v3 active with JWT verification on; the image scanners,
publisher, and owner-preview functions are also deployed (see
`PRIVATE_PENDING_MEDIA.md`). Their deployment alone does not turn on AI
generation or posting. The hosted function now requests 816×816 or 1088×608
sources, while the image feature flags remain off. Both updated functions
returned their disabled 503 response with the anonymous project JWT and 401
without an Authorization header; their deployed files were read back and
matched the intended source. The un-applied crop-review migration precedes
the age migration in this branch. Keep the age migration pending until its
ordered rollout; the missing RPC fails closed if flags are changed early.
Inspect the
exact project and private bucket settings before enabling those flags. The
publisher's matching secret, queue wakeup,
and scheduled sweep are installed. An ordinary staging image ad completed
the hosted scan and publication flow; no AI-generated ad has done so.
The dashboard editor may need the shared http.ts file copied locally, as
described for existing functions in the Supabase README.

After the ordered age migration, verified adult assessment and trusted
short-lived grants are available, confirm `OPENAI_API_KEY` as an Edge Function
secret. Only then consider setting `ADBATTLE_AI_IMAGE_ENABLED=true` and
`ADBATTLE_AI_IMAGE_POST_ENABLED=true` in adbattle-test for a bounded tester
exercise. The same server key is
used for prompt policy screening and image generation. Provision the adult
test approval claim through a privileged Auth administrator after confirming
the tester's eligibility; the claim and separate server-owned action grants
are both required. Never save secrets in index.html, frontend-config.js, committed
config, URLs, or logs. The existing local staging launcher uses the test
publishable key. Test with an approved adult signed-in account: generate one
harmless image, inspect the private bucket and quota row, review and select
the draft, submit it, and confirm the two scanner statuses and public badge.
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
the exact v5 real-function source restored as v9 with JWT verification on;
the endpoint returned 503 with generation disabled before this probe.
This does not establish behavior on real provider or high-entropy images, or
the full function's resource use. No hosted provider generation and complete
AI publication flow has been verified yet. If preview expires, the saved
request ID can obtain a fresh signed URL without another image call.

After a lost response, keep the saved request ID and prompt and recover the
draft. A three-minute abandoned reservation becomes unknown, remains counted
against quota, and cannot be sent to the image model again. Draft Storage
objects do not yet have automatic retention cleanup; add scheduled removal with enough
request history retained for same-day idempotency before wider rollout.

OpenAI references: https://developers.openai.com/api/docs/models/gpt-image-2.5-flare ,
https://developers.openai.com/api/docs/guides/image-generation ,
https://developers.openai.com/api/reference/resources/images/methods/generate/ ,
https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance ,
and https://developers.openai.com/api/docs/guides/your-data .

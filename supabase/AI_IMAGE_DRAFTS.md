# Staging AI image drafts

This integration is limited to the adbattle-test project
(nccqnrcdygujulrnwair) at http://localhost:8000. The public frontend feature
flag is false. The Edge Function also requires the exact test project URL,
origin, and ADBATTLE_AI_IMAGE_ENABLED=true. Do not deploy this to the public
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
   at `auto`, and no image or reference input. The square request is
   1024x1024; the smallest supported exact 16:9 request under the model's
   minimum-area and dimension rules is 1280x720. The server validates the
   raw `data[0].b64_json`, expected dimensions, JPEG markers, and an 8 MiB
   byte ceiling. It never sends the browser's raw provider settings.
5. The unmodified provider image is saved to the private ai-image-drafts
   bucket under the owner's path. The creator fetches it through a ten-minute
   signed URL. The server keeps a SHA-256 checksum, model, prompt/style hash,
   and request status. A completed request can receive another signed URL
   without another model call.
6. The browser converts the draft to a JPEG at most 640 pixels along its long
   side and 500 KiB. The creator reviews it, then chooses Use this image or
   Discard draft. Generation never posts an ad. Explicit submission uses the
   existing public ad-images upload and both independent scanners.

The ad insert trigger verifies that the AI draft belongs to the submitting
creator and completed, then sets durable ai_generated provenance and a source
request ID. New fixed-column read RPCs expose a Made with AdBattle AI badge on
public and owner cards; existing RPC signatures remain intact. The badge
is an attribution hint: the ad references a completed draft owned by the
creator. The resized uploaded bytes are not cryptographically bound to the
private source image, so exact media provenance remains a release gate. Users
may also use other AI tools outside AdBattle without this badge.

No wallet, Support, creator, or promotion funds are debited by generation.
The private source has no AdBattle watermark. Public export/watermark behavior
remains a separate media pipeline.

## Staging setup and review

Apply migrations `20260923162944_ai_image_draft_quota.sql` and
`20260923170351_openai_image_draft_model.sql` to adbattle-test only at first.
The first creates a private 8 MiB JPEG/PNG bucket, a request table with RLS
and no browser grants, a service-only reservation RPC, and the provenance
trigger/read RPCs. The second switches the default model for new reservation
rows to Flare without rewriting existing draft history. Inspect the exact
project and private bucket settings before enabling the function. Deploy only
generate-ai-image to test with JWT verification on. The dashboard editor may
need the shared http.ts file copied locally, as described for existing
functions in the Supabase README.

Set `OPENAI_API_KEY` as an Edge Function secret and set
`ADBATTLE_AI_IMAGE_ENABLED=true` only in adbattle-test. The same server key is
used for prompt policy screening and image generation. Provision the adult
test approval claim through a privileged Auth administrator after confirming
the tester's eligibility; missing or false claims fail before quota
reservation. Never save secrets in index.html, frontend-config.js, committed
config, URLs, or logs. The existing local staging launcher uses the test
publishable key. Test with an approved adult signed-in account: generate one
harmless image, inspect the private bucket and quota row, review and select
the draft, submit it, and confirm the two scanner statuses and public badge.
Automated tests mock both model calls and run the real quota SQL locally; they
make no paid generation request. OpenAI account
access to Flare, any organization verification, actual output shape/latency,
and provider usage or invoice cost must be checked in restricted staging.

The browser must fetch the signed private URL from localhost to receive image
bytes for canvas conversion. Verify that hosted Storage sends the needed CORS
headers in this smoke test; the private bucket does not exist in the current
hosted staging project, so this path cannot be checked before staging setup.
If the download fails, the saved request ID remains and recovery asks the
server for a fresh signed URL without another image call.

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

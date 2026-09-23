# Staging AI image drafts

This integration is limited to the adbattle-test project
(nccqnrcdygujulrnwair) at http://localhost:8000. The public frontend feature
flag is false. The Edge Function also requires the exact test project URL,
origin, and ADBATTLE_AI_IMAGE_ENABLED=true. Do not deploy this to the public
site before deciding a generation budget and access policy.

## Flow and limits

1. A signed-in creator enters a prompt of at most 400 characters and chooses
   pixel art, flat illustration, simple 3D, loose hand-drawn, or freeform
   simple, and a 1:1 or 16:9 shape. A UUID is saved
   locally before the request so a lost response can be recovered with the same
   ID and prompt.
2. A service-only database RPC atomically reserves a request before any model
   call. It caps generation at 3 requests per creator per UTC day and 30
   globally, with one active request per creator. Server settings
   ADBATTLE_AI_IMAGE_USER_DAY_LIMIT and ADBATTLE_AI_IMAGE_GLOBAL_DAY_LIMIT may
   lower those caps, not raise them. Failed and uncertain outcomes consume
   quota. A reserved request is never sent to Gemini twice.
3. The existing OpenAI ad-policy model checks the proposed image prompt before
   Gemini. Held, rejected, malformed, or unavailable policy results fail closed
   and do not generate. This is a preliminary text check; the posted image still
   must pass the existing image safety and duplicate scans.
4. The server calls Google's Interactions REST API with
   gemini-3.1-flash-lite-image, one 1K JPEG in the selected shape, minimal
   thinking, no tools,
   and store=false. It reads the raw completed model_output steps, requires
   exactly one image, and checks format and an 8 MiB size ceiling.
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

Apply migration 20260923162944_ai_image_draft_quota.sql to adbattle-test only
at first. It creates a private 8 MiB JPEG/PNG bucket, a request table with RLS
and no browser grants, a service-only reservation RPC, and the provenance
trigger/read RPCs. Inspect the exact project and private bucket settings before
enabling the function. Deploy only generate-ai-image to test with JWT
verification on. The dashboard editor may need the shared http.ts file copied
locally, as described for existing functions in the Supabase README.

Set GEMINI_API_KEY and OPENAI_API_KEY as Edge Function secrets and set
ADBATTLE_AI_IMAGE_ENABLED=true only in adbattle-test. Never save secrets in
index.html, frontend-config.js, committed config, URLs, or logs. The existing
local staging launcher uses the test publishable key. Test with an ordinary
signed-in account: generate one harmless image, inspect the private bucket and
quota row, review and select the draft, submit it, and confirm the two scanner
statuses and public badge. Automated tests mock both model calls and run the
real quota SQL locally; they make no paid generation request.

The browser must fetch the signed private URL from localhost to receive image
bytes for canvas conversion. Verify that hosted Storage sends the needed CORS
headers in this smoke test; the private bucket does not exist in the current
hosted staging project, so this path cannot be checked before staging setup.
If the download fails, the saved request ID remains and recovery asks the
server for a fresh signed URL without another Gemini call.

After a lost response, keep the saved request ID and prompt and recover the
draft. A three-minute abandoned reservation becomes unknown, remains counted
against quota, and cannot be sent to Gemini again. Draft Storage objects do
not yet have automatic retention cleanup; add scheduled removal with enough
request history retained for same-day idempotency before wider rollout.

Google references: https://ai.google.dev/gemini-api/docs/image-generation and
https://ai.google.dev/api/interactions-api-v1 .

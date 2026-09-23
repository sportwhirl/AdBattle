# AdBattle AI video architecture (design only)

**Status:** proposed end-to-end design for the `wallet-ledger-90-10` branch, 2026-09-23. A separate staging-only job scaffold and offline processor now implement limited portions; this document does not enable generation, deploy an Edge Function, or authorize a public launch. Model availability, prices, provider responses, and limits must be rechecked at implementation time.

## Release gate and scope

Google's [Gemini Developer API terms](https://ai.google.dev/gemini-api/terms) and [Google Cloud Service Specific Terms, section 20(d)](https://cloud.google.com/terms/service-terms) both prohibit using the relevant generative AI service as part of an application directed toward **or likely to be accessed by** people under 18. The [Cloud Services Summary](https://cloud.google.com/terms/services) includes the renamed Vertex AI foundation-model API in Generative AI Services. AdBattle currently has no age controls. A server-side call, moving to Vertex/Agent Platform, or adding an age gate by itself is not an established exception. **Do not enable Google generation on the public AdBattle site until the actual audience/access model and applicable terms are resolved with Google or qualified counsel.** Restricted staging with authorized adult testers can implement and measure this design.

This feature creates a **draft before posting**. The creator can inspect it and either discard it or submit one immutable ad. It does not edit posted media, change the wallet ledger, spend promotion money, or change the existing Support and Seed rules. The first version is one original, 10-second, 360p, 24-fps clip with a deliberate simple visual style; 16:9 and 9:16 are the permitted aspect ratios. The gallery serves a poster first, then a tiny muted hover derivative, then the full video only on user action. These are proposed AdBattle limits, not Google policy or a claim that simple artwork costs fewer model tokens.

Initial proposed style presets are **pixel art, flat illustration, simple low-poly 3D, loose hand-drawn, and other simple style**. Creators choose the scene, characters, humor, colors, pacing, and one preset; the server adds that preset and the output limits to the prompt. Photorealism and high-detail cinematic rendering are outside this first product tier. Require original or licensed reference material and original characters; hold copied brands/characters, real-person impersonation, recognizable voice clones, known songs, and claims the scanner cannot verify. The first release produces a silent full clip and a silent hover clip. The model can deviate from a preset, so inspect the actual output rather than treating prompt text as enforcement. These are proposed **AdBattle editorial rules**, not a list of Google's API restrictions. Low-detail style mainly gives the gallery a coherent look; model choice, duration, and measured output tokens determine generation cost, while transcode settings determine delivery bytes.

## Existing integration points

- `index.html` `postAd()` accepts JPEG/PNG under 10 MB, uploads to public `ad-images/<user-id>/<uuid>`, then inserts an ad. `ads.image_url` is NOT NULL. The browser presents the ad as final after submission.
- `scan-ad` checks that the public image URL belongs to the owner, enforces a byte/MIME/magic limit, hashes exact bytes, and calls OpenAI moderation plus a separate structured ad-policy review. `scan-ad-duplicate` loads `image_storage_path` from `ad-images` and fingerprints the image. Both are currently invoked through separate protected server paths.
- `20260922_duplicate_screening.sql` exposes only fixed-column `get_public_ads()` (approved ads) and `get_my_ads()` (owner ads), and recomputes approval after image safety and duplicate results. Browser roles cannot directly SELECT scanner fields from `ads`.
- `createCard()` assumes `<img src="ad.image">`; `loadAds()` maps `image_url` from those RPCs. The wallet and Support functions rely on the existing ad ID and approval state. Video work must leave these contracts intact for image ads.

There is a critical publication invariant: **a video poster passing the existing two scanners must not approve its unscanned video**. Both the approval trigger and the status-refresh function must enforce a third video gate in the same schema migration, before any video ad is inserted.

## Provider and cost assumptions

The Gemini Developer API's stable [`gemini-omni-1.1-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash) supports 3–10 seconds at 360p, 720p, 1080p, or 4K and 24 fps. Google recommends Omni for general short video and [documents its Interactions workflow](https://ai.google.dev/gemini-api/docs/omni). The [Interactions API reference](https://ai.google.dev/api/interactions-api) supports `background`, `store`, retrieval by interaction ID, `response_format.duration`, resolution, delivery, and aspect ratio. Google's [Cloud video example](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text) spells duration as `"10s"`; verify that exact value against the selected endpoint with one staging request. Google's [Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing) quotes approximately $0.10 per second at **720p** through output-token billing. It does not publish a guaranteed 360p discount. Record actual `usage` and invoice cost before showing any user-facing price.

Cloud/Agent Platform uses a different [Omni ID, `gemini-omni-1.1-flash-preview`](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-1-flash). It is Preview even though the Developer API model is GA; Cloud's model card has inconsistent PayGo statements. The Cloud endpoint's quota and price are unverified for this project and Developer API pricing must not be copied to it. The 1K [Flash Lite image model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image) may generate draft stills, but it is a separate job and budget. Imagen is [shut down in the Gemini API](https://ai.google.dev/gemini-api/docs/image-generation).

The provider's filters and invisible SynthID are additional controls, not AdBattle approval. Retain the unmodified provider original privately; do not assume transcoding preserves an invisible watermark or provenance metadata. [Google's generative AI use policy](https://policies.google.com/terms/generative-ai/use-policy) and [Gemini API terms](https://ai.google.dev/gemini-api/terms) still apply to prompts, references, and outputs.

## Database and access design

Use a private, unexposed `internal.ai_video_jobs` table, an append-only `internal.ai_video_job_events` table, and an immutable `internal.ai_video_scan_results` table keyed by ad and scan version with source/full/hover hashes, sampled-frame manifest hash, result, and timestamp. No browser role receives direct INSERT, UPDATE, DELETE, or SELECT on these tables. Expose narrow authenticated create, status, publish, and discard Edge Functions (or carefully limited owner RPCs). **Every client-facing endpoint** verifies the JWT using Supabase Auth, derives `user_id` from that verification, and never trusts a browser-supplied owner ID. The locked transaction compares that verified user with the job owner. A status response returns only the caller's job ID, public-safe status, and timestamps; when ready, an owner-bound function may issue a short-lived signed preview URL for private draft media. The service-role key and Google credential remain server-side.

Minimum job columns:

| Column | Invariant |
| --- | --- |
| `id uuid`, `user_id uuid`, `client_request_id uuid`, `request_sha256 bytea` | `unique(user_id, client_request_id)`; retries with an identical hash return the same job, changed body returns 409. |
| `prompt`, `style_preset`, `duration_seconds`, `resolution`, `aspect_ratio`, `provider`, `model` | Immutable after creation; initially 10, `360p`, and allowlisted aspect/style. Bounded prompt length and reference rights attestation. |
| `status`, `lease_owner`, `lease_expires_at`, `next_poll_at`, `created_at`, `updated_at` | Only a worker changes state via compare-and-swap/row-lock RPCs; lease expiry never authorizes a second ambiguous provider POST. |
| `provider_request_started_at`, `provider_interaction_id`, `provider_file_uri`, `provider_status`, `provider_usage` | Provider ID unique when non-null. Persist the returned ID and any validated Files API URI from the initial response before scheduling a poll. Keep only bounded diagnostic data; never log prompt/media/API keys. |
| `original_private_path`, `poster_private_path`, `hover_private_path`, `full_private_path`, `original_sha256`, `poster_sha256`, `full_sha256`, `hover_sha256` | Paths are server-created in owner/job namespaces; immutable hashes bind scans and published assets to one output. |
| `publish_request_sha256`, `ad_id`, `error_code`, `review_reason_code` | `ad_id` unique. A repeat publish with identical fields returns the same ad; changed fields fail. No raw provider error or private URI in browser responses. |

Use `internal` only if the project's configured Data API schemas keep it unexposed. Supabase's [Data API guidance](https://supabase.com/docs/guides/api/securing-your-api) distinguishes grants from RLS; enable RLS even for private tables as defense in depth. If PostgREST access to a private-schema RPC is unavailable, place a `SECURITY INVOKER` transaction RPC in `public`, `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`, and `GRANT EXECUTE TO service_role` only. Do not use an unrestricted `SECURITY DEFINER` public function. Explicitly grant the service role the required sequence/table/schema permissions.

Add the following to `public.ads` in one migration, defaulting old rows to the image path:

```sql
media_type text not null default 'image'
  check (media_type in ('image', 'video')),
video_status text not null default 'not_required'
  check (video_status in ('not_required', 'pending', 'passed', 'held', 'failed')),
video_source_job_id uuid unique references internal.ai_video_jobs(id) on delete restrict,
video_original_sha256 text,
video_full_storage_path text,
video_full_sha256 text,
video_hover_storage_path text,
video_hover_sha256 text,
video_scan_version text,
video_scanned_at timestamptz
```

For an image ad, require `video_status='not_required'` and all video fields null. For a video ad, require a unique consumed job, the original hash, poster in the existing `image_url`/`image_storage_path` fields, and `video_status='pending'` on INSERT. Public video paths can be null while pending; they must be present with their **derivative** SHA-256 hashes and scan version before `passed`. Only trusted server code may fill public paths and record the result. Pending originals and derivatives live in private storage. Copy reviewed derivatives to a service-write-only public `ad-videos` bucket under unpredictable, immutable paths; verify the copied objects' actual hashes against the reviewed full and hover bytes, then publish the paths/hashes and `video_status='passed'` in a narrow final transaction. If either copy or verification fails, keep the ad pending. Do not overwrite a published object. A non-null path alone never proves a scan passed.

The shape constraint and browser grant should be included with the gate migration, not deferred to a later frontend release. The following is a design sketch; write a migration against the inspected hosted schema before running it:

```sql
alter table public.ads add constraint ads_media_shape check (
  (media_type = 'image' and video_status = 'not_required'
    and video_source_job_id is null and video_original_sha256 is null
    and video_full_storage_path is null and video_full_sha256 is null
    and video_hover_storage_path is null and video_hover_sha256 is null
    and video_scan_version is null and video_scanned_at is null)
  or
  (media_type = 'video' and video_status <> 'not_required'
    and video_source_job_id is not null and video_original_sha256 is not null
    and (video_status <> 'passed' or
      (video_full_storage_path is not null and video_full_sha256 is not null
       and (video_hover_storage_path is null) = (video_hover_sha256 is null)
       and video_scan_version is not null and video_scanned_at is not null)))
);
revoke insert on public.ads from public, anon, authenticated;
grant insert (user_id, title, caption, image_url, image_storage_path,
  promotion_allocation) on public.ads to authenticated;
-- Keep the existing owner INSERT RLS policy. Grant service_role its required
-- privileges for the atomic video publish and scan-result operations.
```

The migration must replace **both** `enforce_ad_screening_gate()` and `refresh_ad_moderation_status()` with the same condition:

```sql
-- Pseudocode for the condition used in BOTH places.
video_ok := media_type = 'image' OR video_status = 'passed';
approved := safety_status = 'passed'
        AND duplicate_status = 'passed'
        AND video_ok;
rejected := safety_status = 'failed'
        OR duplicate_status = 'rejected'
        OR video_status = 'failed';
-- Preserve the existing 'removed' terminal status before either branch.
```

On INSERT the trigger forces image/video scan states to their pending values; an UPDATE to `approved` fails unless the condition holds. The video-result RPC locks the ad, verifies pending status and immutable source/job identity, checks the full/hover asset paths and SHA-256 values against the immutable scan record and freshly verified public objects, records pass/hold/fail plus an audit event, then refreshes approval. It is callable by `service_role` only. Keep the existing `safety_status` and duplicate terminal transition behavior; a `held` video never approves. Historical image ads must remain approved without a video scan.

The existing browser has table-wide INSERT on `ads`. Revoke that INSERT and grant only the current image submission columns (`user_id`, `title`, `caption`, `image_url`, `image_storage_path`, `promotion_allocation`) to `authenticated`; keep generated/default fields omitted. The browser must not be able to set `media_type`, video status, job ID, hashes, or video paths. A server-only atomic `publish_generated_video` RPC verifies the job owner and `ready_draft` state, locks the job, compares the publish request hash, inserts one video ad, and records its `ad_id`. A retry returns that ID; a second different publish fails. Revoke all default function EXECUTE grants before granting service role. Browser UPDATE/DELETE of ad content remain unavailable. Update `get_public_ads()` and `get_my_ads()` with only `media_type`, approved public video URLs, and owner-safe status; never expose job internals or private paths. Preserve existing RLS and the creator attribution contract.

PostgreSQL cannot use `CREATE OR REPLACE FUNCTION` to change the existing table-returning RPC's return columns. Prefer versioned `get_public_ads_v2()` and `get_my_ads_v2()` with explicit grants and the same approval/owner filters, switch the frontend, then retire the old RPCs after compatibility verification. Preserve the fixed-column contract for old clients during rollout. A dashboard Database Webhook is not created by the SQL migration: configure and authenticate the video scan trigger in staging separately, and verify that a missed webhook leaves the ad pending rather than published.

## Exact job states and delivery

| State | Entry and allowed next state |
| --- | --- |
| `queued` | Authenticated request committed and quota reserved; claim to `dispatching`, or `cancelled` before dispatch. |
| `dispatching` | One worker has committed `provider_request_started_at` **before** HTTP POST. Valid accepted response with ID → `generating`; known definite rejection (for example a clearly unaccepted 429) → bounded backoff/`queued` or `failed`; timeout, 5xx, malformed response, lost response, or crash without ID → `dispatch_uncertain`. |
| `dispatch_uncertain` | No automatic second POST. Operator checks provider usage/logs and any known request correlation; if an actual provider ID is proven, record it and resume `generating`. Otherwise cancel/close the job after reconciliation. A new request requires a new explicit action and quota/billing accounting. |
| `generating` | Poll GET by persisted interaction ID; `in_progress` stays, `completed` → `processing`, provider terminal failure → `failed`, policy block → `rejected`; cancel only with documented provider cancellation and confirmation. |
| `processing` | Download bounded original, decode and transcode, then validate and scan. Safe → `ready_draft`; ambiguous → `held`; technical failure → `failed`; prohibited → `rejected`. |
| `ready_draft` | Owner can preview and submit, moving atomically to `posted`, or discard/cancel. The draft is not public or Support-eligible. |
| `posted` | Terminal job state with one `ad_id`; ad remains `pending_scan` until poster/text, duplicate, and video scans pass. Ad moderation may later be rejected/removed without changing this job history. |
| `held`, `rejected`, `failed`, `cancelled` | Terminal without public video. Administrative review can create an explicitly audited disposition; it must not silently restart generation or bypass a scan. |

The job table is the source of truth; Supabase Queues can carry wake-up messages. A queue message is acknowledged only after the corresponding durable state transition. Duplicate messages and lease expiry call an idempotent state handler. Schedule short pollers with [Supabase Cron](https://supabase.com/docs/guides/cron) and consider [Queues visibility windows](https://supabase.com/docs/guides/queues). Initial **staging** limits: one active job per user, one request per user per UTC day, and five project-wide per UTC day, all configurable server-side. Reserve a slot at job creation and count rejected, failed, and uncertain attempts; do not reset its quota on a browser timeout. Add an operator kill switch and provider spending alert before paid testing.

## Provider REST and response handling

For the Gemini Developer API staging adapter, use a server-only POST to `https://generativelanguage.googleapis.com/v1beta/interactions` with `x-goog-api-key`. The exact payload is to be confirmed against a live staging call:

```json
{
  "model": "gemini-omni-1.1-flash",
  "input": "An original, simple flat illustration ...",
  "background": true,
  "store": true,
  "stream": false,
  "response_format": {
    "type": "video",
    "duration": "10s",
    "resolution": "360p",
    "aspect_ratio": "16:9",
    "delivery": "uri"
  }
}
```

Do not put prompts or keys in URLs, browser code, or logs. Parse the raw REST `id`, `status`, `errors`, `usage`, and `steps[].content[]`; `output_video` in SDK examples is a convenience accessor, not a guaranteed top-level REST field. On completion accept exactly one video content block with `mime_type='video/mp4'` and either `uri` or base64 `data`; reject missing/multiple/unknown output. Poll `GET /v1beta/interactions/{id}` with bounded exponential backoff and a maximum age, then reconcile aged jobs without sending another POST. Google documents [cancel and GET](https://ai.google.dev/api/interactions-api) and [URI/File delivery](https://ai.google.dev/gemini-api/docs/omni). **A URI is guaranteed only in the initial POST response or SSE stream.** Persist a validated Files API URI from that response when available, poll that file to `ACTIVE`, then download. A later interaction GET currently may return inline base64 even if creation requested URI, so support a bounded inline fallback when no initial URI was available. Do not assume URI delivery prevents a large response. Restrict downloads to Google's known API/file endpoint, authenticate server-side, enforce a hard byte cap while streaming, and avoid storing base64 in audit rows. Unrecognized response shapes fail closed. A container worker is preferable for the final download; Supabase Edge's [memory/CPU/wall-clock limits](https://supabase.com/docs/guides/functions/limits) apply even to [background tasks](https://supabase.com/docs/guides/functions/background-tasks).

Provider POST idempotency is **not documented** in the Interactions API. Local request UUIDs protect AdBattle's own inserts, not a billable provider call whose response was lost. The staging scaffold calls this conservative state `dispatch_unknown`; the full design table above calls it `dispatch_uncertain`. Both mean no second provider POST and operator reconciliation. If the provider later adds a documented idempotency mechanism, it can be adopted after testing without weakening this default.

## Media validation, moderation, and publication

Keep FFmpeg/ffprobe in a constrained container worker, not an Edge Function. [Supabase Storage uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads) work best under 6 MB; use [resumable upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) for larger objects, and enforce the project's [Storage object limit](https://supabase.com/docs/guides/storage/uploads/file-limits). Supabase documents image transformations, not a native video-transcoding service. The worker must use a temporary directory with size/time limits, fixed tool arguments, no shell interpolation of user prompts or filenames, and reject external/extra streams or unparseable media.

Initial staging acceptance budgets (to be tuned after real samples): one H.264 MP4 input up to 30 MiB, 8–12 seconds for the requested ten-second output, matching 16:9 or 9:16 geometry and 12–60 fps, one video stream (the processor discards any audio). The bounded offline processor normalizes to a silent 10.0-second, 24-fps, 360p full MP4 of at most 5 MiB, a 360p JPEG poster of at most 100 KiB, and, if its hard cap is met, a separate silent four-second, 13-fps, 360p hover MP4 of at most 500 KiB. An oversized hover falls back to the poster; any other required-output failure fails the draft. These are **site delivery** budgets. Re-encoding and style presets do not imply a Google generation discount. Keep original bytes and SHA-256 privately; record derivative hashes, dimensions, durations, codecs, and byte sizes.

Before a draft is offered, evaluate prompt and references, validate the generated file, and perform a preliminary content check. At posting, scan the complete ad context: title, caption, poster, video frames across the timeline (including first/last and scene changes), OCR/text overlays, and a speech transcript plus audio-risk review. The existing `scan-ad` and duplicate scanner handle the poster; add a video-specific scanner and immutable scan version/audit events. Compare exact video SHA-256 and sampled frame fingerprints to prior posted clips and hold suspicious duplicates. Automated samples can miss a brief unsafe frame; uncertain or high-risk cases require human review. A model's refusal/safety pass does not replace AdBattle policy. Do not claim that a generated soundtrack is free of rights issues.

Immediately before the atomic ad insert, the publish worker copies the **preliminarily screened** poster from the private draft bucket to a service-only prefix `ad-images/<owner>/ai-posters/<job-id>.jpg` and fixes that URL and path in the ad. This preserves the current `scan-ad` owner URL-prefix check and duplicate scanner. Audit and change the hosted `storage.objects` policies before rollout so authenticated clients cannot INSERT, UPDATE, DELETE, or upsert in `ai-posters/`, even inside their own folder; the service role alone can write there. Verify these denials with a real owner session. On retry, an existing poster at that deterministic path is acceptable only when its hash matches the scanned draft. A failed insert can leave an orphan: a later sweeper may delete only after checking no ad references that path and a grace period has elapsed. Do not delete immediately from a racing request, which could erase another successful publish's poster. As with today's public image uploads, a pending poster URL is technically public if discovered; do not promise that an unlisted path provides privacy. The original video and its derivatives remain private until the video scan passes.

For approved video ads, copy only the reviewed derivative bytes to public `ad-videos`, then atomically record their paths, hashes, and video pass. Public-read storage should deny browser write/upsert; draft storage is private and service-only. Deleted/rejected/removed ads must stop appearing through `get_public_ads()` even if a CDN has previously cached a URL. Use immutable object names and cache policy; [Supabase CDN behavior](https://supabase.com/docs/guides/storage/cdn/fundamentals) means removing an object is not an instantaneous universal cache purge. Do not rely on an unlisted public URL being secret while moderation is pending.

The gallery renders `<img loading="lazy">` with an accessible play button. It does not set a video `src` or preload on initial card render. Pointer hover, after a short delay, fetches only the muted hover derivative when motion/data preferences permit; leave/cancel stops playback. Touch and keyboard users get the same explicit play control without hover. Full video uses `preload="none"`, `playsinline`, controls and initially muted playback; audible playback requires deliberate action. Do not auto-fetch video for every card. The existing card actions and owner moderation badge continue to work for image and video ads.

## Verification and rollout

1. **Local schema tests:** Apply the proposed migration to the repo's PGlite fixture and a disposable PostgreSQL instance. Verify old approved image rows stay approved; video poster safety + duplicate pass cannot approve a pending/held/failed video; only video pass completes the gate; removed remains removed; an owner cannot set video columns, query private job rows, or execute service RPCs. Check `get_public_ads()` never exposes pending or private media, and `get_my_ads()` exposes only the caller's safe fields. Run Supabase advisors before a real migration.
2. **Mock provider tests:** Simulate accepted/in-progress/completed URI and inline data; definite rejection, 429, 5xx, timeout, malformed JSON, missing ID, blocked, and cancelled. Assert one provider POST maximum after ambiguous outcomes, persistent interaction ID before polling, duplicate queue-message safety, bounded response/download bytes, immutable request hash, quotas, and atomic one-ad publication.
3. **Fixture media tests:** Exercise invalid magic/container, truncation, codec/track anomalies, duration/dimension/file-size boundaries, failed transcodes, speech and scene-change extraction, frame/audio policy holds, fingerprint duplicate, and storage copy failure. Verify no public path or approval is recorded after any failure.
4. **Browser tests:** Image cards still render; video cards issue no video requests on initial gallery load; hover fetch is conditional and muted; mobile/keyboard/reduced-motion/data-saver behavior, poster fallback, owner pending state, and explicit play work.
5. **Restricted `adbattle-test` staging:** Deploy schema gate and code from one reviewed commit with generation disabled. Run authorization checks with two ordinary users, then enable one paid 10-second/360p Google test only for approved adult testers. Record real output dimensions, response shape, generation time, provider usage/billing, storage/transcode bytes, review results, and cancellation/retry behavior. Keep wallet and Stripe test mode unchanged.
6. **Public release:** Remains blocked on Google audience/terms resolution, verified provider access/price, validated transcoding and moderation operations, per-user/global cost controls, and a review process. Do not enable this through a feature flag alone before those gates pass.

No live provider call, paid generation, hosted migration, or Edge deployment was performed. The separate offline FFmpeg processor passes synthetic fixtures for the size and format caps, but is not connected to the job worker. Without an authorized paid API key, actual 360p billing, `"10s"` behavior, provider quota, and response shape remain unverified. Real provider samples and full media moderation are still needed before publication.

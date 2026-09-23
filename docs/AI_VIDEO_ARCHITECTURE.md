# AdBattle AI video architecture (design only)

**Status:** proposed end-to-end design for the `wallet-ledger-90-10` branch, 2026-09-23. A separate staging-only job scaffold and offline processor now implement limited portions; this document does not enable generation, deploy an Edge Function, or authorize a public launch. Model availability, prices, provider responses, and limits must be rechecked at implementation time.

## Release gate and scope

The product target is creative access for all ages. The
[youth access plan](YOUTH_ACCESS_PLAN.md) defines account, consent, privacy,
and moderation gates. Google's
[Gemini API terms](https://ai.google.dev/gemini-api/terms) prohibit an API client likely to be
accessed by under-18s, so Gemini is not this app's public video route. The
staging job adapter targets Luma Ray 3.2 for approved **adult testers only**.
Luma's [individual terms](https://lumalabs.ai/legal/terms-of-service) say
under-13 users are unauthorized; its
[API terms](https://lumalabs.ai/legal/api-terms-of-use) define downstream API users.
Do not route child video requests to it without explicit provider permission.
Confirm the teen path, commercial use, and 360p draft-tier publishing in
writing before a public switch. AI-assisted animation from approved image
generation is a separate proposed route, not part of this job scaffold.

This feature creates a **draft before posting**. The creator can inspect it and either discard it or submit one immutable ad. It does not edit posted media, change the wallet ledger, spend promotion money, or change the existing Support and Seed rules. The first version is one original, 10-second, 360p, 24-fps clip; 16:9 and 9:16 are the permitted aspect ratios. The gallery serves a poster first, then a tiny muted hover derivative, then the full video only on user action. These are proposed AdBattle delivery limits, not provider policy or a claim that simple artwork costs fewer model tokens.

Optional style directions are **pixel art, flat illustration, low-poly 3D,
loose hand-drawn, and the creator's own style**. Creators choose the scene,
characters, humor, colors, pacing, and prompt freely within safety rules.
Photorealistic fictional art and detailed ideas may be proposed; the small
public file can lose fine detail, so preview legibility. Hold copied
brands/characters, deceptive real-person impersonation, recognizable voice
clones, known songs, and claims the scanner cannot verify. The first release
produces a silent full clip and a silent hover clip. The model can deviate from
a style request, so inspect the actual output. Low-detail style is an option;
model choice and duration determine generation cost, while transcoding
determines delivery bytes.

## Existing integration points

- `index.html` `postAd()` accepts JPEG/PNG under 10 MB, uploads to public `ad-images/<user-id>/<uuid>`, then inserts an ad. `ads.image_url` is NOT NULL. The browser presents the ad as final after submission.
- `scan-ad` checks that the public image URL belongs to the owner, enforces a byte/MIME/magic limit, hashes exact bytes, and calls OpenAI moderation plus a separate structured ad-policy review. `scan-ad-duplicate` loads `image_storage_path` from `ad-images` and fingerprints the image. Both are currently invoked through separate protected server paths.
- `20260922_duplicate_screening.sql` exposes only fixed-column `get_public_ads()` (approved ads) and `get_my_ads()` (owner ads), and recomputes approval after image safety and duplicate results. Browser roles cannot directly SELECT scanner fields from `ads`.
- `createCard()` assumes `<img src="ad.image">`; `loadAds()` maps `image_url` from those RPCs. The wallet and Support functions rely on the existing ad ID and approval state. Video work must leave these contracts intact for image ads.

There is a critical publication invariant: **a video poster passing the existing two scanners must not approve its unscanned video**. Both the approval trigger and the status-refresh function must enforce a third video gate in the same schema migration, before any video ad is inserted.

## Provider and cost assumptions

Luma's [Ray 3.2 API](https://docs.agents.lumalabs.ai/api/resources/generations/methods/create)
offers 10-second standard-dynamic-range video at 360p. Its [published
pay-as-you-go price](https://docs.agents.lumalabs.ai/guides/pricing) is $0.18
for one 10-second `type:"video"` 360p generation, subject to change. Shared
capacity has no latency SLA. Record actual provider charge and wait time
before setting a user-facing allowance or promise. Luma describes 360p as a
draft tier; confirm public commercial publishing rights. Keep image generation
as a separate OpenAI job and budget.

Provider filters are only a first layer, not AdBattle approval. Retain the
unmodified provider original privately and label generated media in the app;
do not assume transcoding preserves provenance metadata.

## Database and access design

For a **future publication backend**, use a private, unexposed
`internal.ai_video_jobs` table, an append-only event table, and an immutable
scan-result table keyed by ad and scan version with source/full/hover hashes,
sampled-frame manifest hash, result, and timestamp. No browser role receives
direct access to those future private tables. The existing **staging scaffold**
instead uses `public.ai_video_draft_jobs` with owner-only RLS and safe-column
SELECT grants; provider IDs, URLs, prompts, and reviewer fields are not
browser-readable. Expose narrow authenticated create, status, publish, and
discard Edge Functions for a public version. **Every client-facing endpoint**
verifies the JWT using Supabase Auth, derives `user_id` from that verification,
and never trusts a browser-supplied owner ID. The locked transaction compares
that verified user with the job owner. A status response returns only the
caller's job ID, public-safe status, and timestamps; when ready, an owner-bound
function may issue a short-lived signed preview URL for private draft media.
The service-role key and Luma credential remain server-side. Public routes
must recheck server-owned age/guardian entitlements in addition to JWT ownership.

Minimum job columns:

| Column | Invariant |
| --- | --- |
| `id uuid`, `user_id uuid`, `client_request_id uuid`, `request_sha256 bytea` | `unique(user_id, client_request_id)`; retries with an identical hash return the same job, changed body returns 409. |
| `prompt`, `style_preset`, `duration_seconds`, `resolution`, `aspect_ratio`, `provider`, `model` | Immutable after creation; initially 10, `360p`, and allowlisted aspect/style. Bounded prompt length and reference rights attestation. |
| `status`, `lease_owner`, `lease_expires_at`, `next_poll_at`, `created_at`, `updated_at` | Only a worker changes state via compare-and-swap/row-lock RPCs; lease expiry never authorizes a second ambiguous provider POST. |
| `provider_request_started_at`, `provider_generation_id`, `provider_output_url`, `provider_status`, `provider_usage` | Provider ID unique when non-null. Persist the generation ID before polling. A completed output URL expires; download promptly with a host allowlist and byte cap. Keep only bounded diagnostics; never log prompt/media/API keys or expose the URL. |
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
| `generating` | Poll GET by persisted generation ID; `queued`/`processing` stays, `completed` → `processing` for AdBattle media handling, provider terminal failure → `failed`, policy block → `rejected`; cancel only with documented provider cancellation and confirmation. |
| `processing` | Download bounded original, decode and transcode, then validate and scan. Safe → `ready_draft`; ambiguous → `held`; technical failure → `failed`; prohibited → `rejected`. |
| `ready_draft` | Owner can preview and submit, moving atomically to `posted`, or discard/cancel. The draft is not public or Support-eligible. |
| `posted` | Terminal job state with one `ad_id`; ad remains `pending_scan` until poster/text, duplicate, and video scans pass. Ad moderation may later be rejected/removed without changing this job history. |
| `held`, `rejected`, `failed`, `cancelled` | Terminal without public video. Administrative review can create an explicitly audited disposition; it must not silently restart generation or bypass a scan. |

The job table is the source of truth; Supabase Queues can carry wake-up messages. A queue message is acknowledged only after the corresponding durable state transition. Duplicate messages and lease expiry call an idempotent state handler. Schedule short pollers with [Supabase Cron](https://supabase.com/docs/guides/cron) and consider [Queues visibility windows](https://supabase.com/docs/guides/queues). Initial **staging** limits: one active job per user, one request per user per UTC day, and five project-wide per UTC day, all configurable server-side. Reserve a slot at job creation and count rejected, failed, and uncertain attempts; do not reset its quota on a browser timeout. Add an operator kill switch and provider spending alert before paid testing.

## Provider REST and response handling

For the Luma Agents staging adapter, use a server-only POST to
`https://agents.lumalabs.ai/v1/generations` with a Bearer key. The exact
payload is:

```json
{
  "model": "ray-3.2",
  "type": "video",
  "prompt": "An original scene in the creator's chosen style ...",
  "aspect_ratio": "16:9",
  "video": { "duration": "10s", "resolution": "360p" }
}
```

Do not put prompts or keys in URLs, browser code, or logs. Persist the raw
generation UUID from the accepted POST and poll
`GET /v1/generations/{id}` with a bounded interval and maximum age. Accept
only documented queued/processing/completed/failed states. Completion carries
a presigned output URL that expires in about an hour; store it privately,
restrict its host and redirects, enforce a hard byte cap while streaming, and
download promptly to private storage. Unrecognized response shapes fail
closed. The staging scaffold stops at private job status; it does **not**
download or publish video. A constrained container worker is preferable for
the final download/transcode; Supabase Edge's
[resource limits](https://supabase.com/docs/guides/functions/limits) apply even
to [background tasks](https://supabase.com/docs/guides/functions/background-tasks).

Provider POST idempotency is not assumed. Local request UUIDs protect
AdBattle's own inserts, not a billable provider call whose response was lost.
The staging scaffold calls this conservative state `dispatch_unknown`; the
full design table above calls it `dispatch_uncertain`. Both mean no second
provider POST and operator reconciliation.

## Media validation, moderation, and publication

Keep FFmpeg/ffprobe in a constrained container worker, not an Edge Function. [Supabase Storage uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads) work best under 6 MB; use [resumable upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) for larger objects, and enforce the project's [Storage object limit](https://supabase.com/docs/guides/storage/uploads/file-limits). Supabase documents image transformations, not a native video-transcoding service. The worker must use a temporary directory with size/time limits, fixed tool arguments, no shell interpolation of user prompts or filenames, and reject external/extra streams or unparseable media.

Initial staging acceptance budgets (to be tuned after real samples): one H.264 MP4 input up to 30 MiB, 8–12 seconds for the requested ten-second output, matching 16:9 or 9:16 geometry and 12–60 fps, one video stream (the processor discards any audio). The bounded offline processor normalizes to a silent 10.0-second, 24-fps, 360p full MP4 of at most 5 MiB, a 360p JPEG poster of at most 100 KiB, and, if its hard cap is met, a separate silent four-second, 13-fps, 360p hover MP4 of at most 500 KiB. An oversized hover falls back to the poster; any other required-output failure fails the draft. These are **site delivery** budgets. Re-encoding and style presets do not imply a provider generation discount. Keep original bytes and SHA-256 privately; record derivative hashes, dimensions, durations, codecs, and byte sizes.

Before a draft is offered, evaluate prompt and references, validate the generated file, and perform a preliminary content check. At posting, scan the complete ad context: title, caption, poster, video frames across the timeline (including first/last and scene changes), OCR/text overlays, and a speech transcript plus audio-risk review. The existing `scan-ad` and duplicate scanner handle the poster; add a video-specific scanner and immutable scan version/audit events. Compare exact video SHA-256 and sampled frame fingerprints to prior posted clips and hold suspicious duplicates. Automated samples can miss a brief unsafe frame; uncertain or high-risk cases require human review. A model's refusal/safety pass does not replace AdBattle policy. Do not claim that a generated soundtrack is free of rights issues.

Immediately before the atomic ad insert, the publish worker copies the **preliminarily screened** poster from the private draft bucket to a service-only prefix `ad-images/<owner>/ai-posters/<job-id>.jpg` and fixes that URL and path in the ad. This preserves the current `scan-ad` owner URL-prefix check and duplicate scanner. Audit and change the hosted `storage.objects` policies before rollout so authenticated clients cannot INSERT, UPDATE, DELETE, or upsert in `ai-posters/`, even inside their own folder; the service role alone can write there. Verify these denials with a real owner session. On retry, an existing poster at that deterministic path is acceptable only when its hash matches the scanned draft. A failed insert can leave an orphan: a later sweeper may delete only after checking no ad references that path and a grace period has elapsed. Do not delete immediately from a racing request, which could erase another successful publish's poster. As with today's public image uploads, a pending poster URL is technically public if discovered; do not promise that an unlisted path provides privacy. The original video and its derivatives remain private until the video scan passes.

For approved video ads, copy only the reviewed derivative bytes to public `ad-videos`, then atomically record their paths, hashes, and video pass. Public-read storage should deny browser write/upsert; draft storage is private and service-only. Deleted/rejected/removed ads must stop appearing through `get_public_ads()` even if a CDN has previously cached a URL. Use immutable object names and cache policy; [Supabase CDN behavior](https://supabase.com/docs/guides/storage/cdn/fundamentals) means removing an object is not an instantaneous universal cache purge. Do not rely on an unlisted public URL being secret while moderation is pending.

The gallery renders `<img loading="lazy">` with an accessible play button. It does not set a video `src` or preload on initial card render. Pointer hover, after a short delay, fetches only the muted hover derivative when motion/data preferences permit; leave/cancel stops playback. Touch and keyboard users get the same explicit play control without hover. Full video uses `preload="none"`, `playsinline`, controls and initially muted playback; audible playback requires deliberate action. Do not auto-fetch video for every card. The existing card actions and owner moderation badge continue to work for image and video ads.

## Verification and rollout

1. **Local schema tests:** Apply the proposed migration to the repo's PGlite fixture and a disposable PostgreSQL instance. Verify old approved image rows stay approved; video poster safety + duplicate pass cannot approve a pending/held/failed video; only video pass completes the gate; removed remains removed; an owner cannot set video columns, query private job rows, or execute service RPCs. Check `get_public_ads()` never exposes pending or private media, and `get_my_ads()` exposes only the caller's safe fields. Run Supabase advisors before a real migration.
2. **Mock provider tests:** Simulate accepted/queued/processing/completed states and expiring output URLs; definite rejection, 429, 5xx, timeout, malformed JSON, missing ID, blocked, and cancelled. Assert one provider POST maximum after ambiguous outcomes, persistent generation ID before polling, duplicate queue-message safety, bounded response/download bytes, immutable request hash, quotas, and atomic one-ad publication.
3. **Fixture media tests:** Exercise invalid magic/container, truncation, codec/track anomalies, duration/dimension/file-size boundaries, failed transcodes, speech and scene-change extraction, frame/audio policy holds, fingerprint duplicate, and storage copy failure. Verify no public path or approval is recorded after any failure.
4. **Browser tests:** Image cards still render; video cards issue no video requests on initial gallery load; hover fetch is conditional and muted; mobile/keyboard/reduced-motion/data-saver behavior, poster fallback, owner pending state, and explicit play work.
5. **Restricted `adbattle-test` staging:** Deploy schema gate and code from one reviewed commit with generation disabled. Run authorization checks with two ordinary users, then enable one paid 10-second/360p Luma test only for approved adult testers. Record real output dimensions, response shape, generation time, provider billing, storage/transcode bytes, review results, and cancellation/retry behavior. Keep wallet and Stripe test mode unchanged.
6. **Public release:** Remains blocked on the youth access plan, written provider clearance for the age band and use, verified access/price, validated transcoding and moderation operations, per-user/global cost controls, and a review process. Do not enable this through a feature flag alone before those gates pass.

No live provider call, paid generation, hosted migration, or Edge deployment was performed. The separate offline FFmpeg processor passes synthetic fixtures for the size and format caps, but is not connected to the job worker. Without an authorized paid API key, actual 360p billing, `"10s"` behavior, provider quota, and response shape remain unverified. Real provider samples and full media moderation are still needed before publication.

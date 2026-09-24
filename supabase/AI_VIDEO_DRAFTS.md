# Staging video draft jobs

This is a **code-only staging scaffold**. Do not apply the migration or deploy
these functions to the production project. The only permitted project is
`adbattle-test` (`nccqnrcdygujulrnwair`). No paid provider call occurs merely
by applying the migration or receiving a user draft request. No generated video
is downloaded, transcoded, displayed, published, or inserted into `ads`.

## Fixed draft contract

| Item | Value |
| --- | --- |
| Provider | Luma Agents REST API candidate, subject to audience permission |
| Model | `ray-3.2` |
| Duration | `10s` |
| Resolution | `360p` |
| Aspect | `16:9` or `9:16` |
| Delivery | Async generation; one private presigned MP4 URL on completion |
| Execution | `POST /v1/generations`, separate `GET /v1/generations/{id}` |
| Style | `freeform_simple` (default), `pixel_art`, `flat_illustration`, `simple_3d`, `hand_drawn` |
| Prompt | 12–600 normalized characters; text only |

The default freeform option lets the creator choose the visual style; the four
named presets only guide the provider. The wrapper asks that the key subject
remain legible at 360p. The output may have a soundtrack, which a future
processor must strip before any public version. No reference uploads, edit,
extension, web search grounding, HDR, model override, or arbitrary durations
are accepted. Luma documents 360p as a lower-cost draft tier, but actual bytes,
codec, run time and billable cost need real staging measurement. Treat a
10-second generation as paid even if the output is rejected.

## Request and review flow

`ai-video-draft` is a signed-in user Edge Function (`verify_jwt = true`). It
requires the server-owned Auth `app_metadata.ai_video_adult_test_approved` claim
to be exactly `true` for creation. The worker checks the user's current server
claim again immediately before dispatch. This is a staging adult-test gate,
not a public age-verification or guardian-permission system. It
accepts `POST` with `Authorization: Bearer <user access token>`, a valid client
UUID and JSON:

```json
{"action":"create","request_id":"10000000-0000-4000-8000-000000000001","prompt":"A playful pencil dances around a bright notebook","aspect_ratio":"16:9","style":"freeform_simple"}
```

It returns a private job ID and `pending_review`. Retrying with the same user
UUID and same normalized draft returns the same job. A changed prompt, style or
aspect under the same UUID returns 409. `POST {"action":"status","job_id":"..."}`
shows only the caller's job and sanitized status, never a provider ID or URI.
The endpoint only gives browser CORS to `http://localhost:8000`. It requires
the exact staging `SUPABASE_URL` plus
`ADBATTLE_AI_STAGING_ENABLED=video-drafts-v1`. User requests never call Luma.

The migration's insert trigger serializes quota decisions. It allows one
attempt per user per UTC day and five attempts globally per UTC day. Rejected
and failed jobs still count; another active job also occupies the user's slot
across midnight. The request identity and output choices cannot be edited.
Authenticated users have an owner-only RLS SELECT policy for safe columns and
no direct write privileges. Provider IDs, signed URLs, prompts and reviewer names
are not readable through the browser's table grants.

**Manual pre-provider safety gate:** The worker's private `inspect` action
returns the prompt and hash to a trusted staging operator. The operator checks
the prompt for prohibited or unsafe ad requests, rights to depict people and
brands, minors, sexual content, hate, violence, fraud, false claims and other
app/provider restrictions, then either rejects it or approves the exact hash.
The `approve` action requires the literal attestation below. The paid worker
claims only approved rows with the same immutable hash. This is a deliberate
human review gate, not an automatic classifier. No unattended review/approval
cron exists. A review process and provider terms assessment are still needed
before any public or youth-facing creation feature. Public video creation stays
disabled. Luma is a candidate only; written provider permission for an app
accessible by under-13 users, or another compatible provider, is required
before that use case can be implemented.

`ai-video-draft-worker` requires a secret header of at least 32 characters,
`x-adbattle-video-worker-secret`, disallows requests with a browser Origin, and
has `verify_jwt = false` because it authenticates the private worker secret.
Provision `ADBATTLE_VIDEO_WORKER_SECRET` and `LUMA_AGENTS_API_KEY` as Edge Function
secrets only in staging; never put them in frontend config. Its private POST
actions are:

| Action | Body fields | Effect |
| --- | --- | --- |
| `inspect` | `job_id` | Reads exact prompt/hash for review |
| `approve` | `job_id`, `request_hash`, `reviewer`, `review_attestation` | Moves reviewed prompt to `queued` |
| `reject` | `job_id`, `request_hash`, `reviewer` | Rejects without provider call |
| `dispatch` | none | Claims at most one queued job and makes one paid POST |
| `poll` | none | Claims at most one due generation GET |

Approval attestation value:

```text
I reviewed this exact prompt against the AdBattle video safety rules
```

Invoke each worker action separately. A scheduler is intentionally not set up;
staging operators can exercise dispatch and polling after review. A later
scheduler must keep the secret private and respect the same project guard.

## Unknown outcomes and processing gap

The worker changes `queued` to `dispatching` **before** POSTing. It never POSTs
that job again if the request times out, crashes, returns malformed or oversized
JSON, or loses its response. It records `dispatch_unknown` when possible and
needs operator reconciliation against provider records. If saving a known
generation ID fails, the worker retries only that database write, then logs
the job ID and generation ID for private reconciliation. Do not reset the
status to `queued` or generate a new UUID to work around uncertainty.

The response reader checks `Content-Length` and enforces a 128 KiB streaming
limit before JSON parsing. A Luma response must identify Ray 3.2 and a video
generation with a UUID. `queued` and `processing` are polled via GET; `failed`
is terminal. `completed` requires exactly one video output with a bounded HTTPS
URL. IP literals, local/opaque hosts, URL credentials, fragments, and oversized
URLs are held for review. The worker does not fetch the URL. GET polling can be
retried after a lease timeout, with a ten-minute processing deadline before
manual review. A completed generation becomes `ready_for_processing`; the
presigned URL remains private and is never returned to a user. It expires after
about an hour and can be refreshed by another private generation GET.

**Still to build:** a private processor must refresh and retrieve the signed
URL, enforce a host allowlist, DNS/IP and redirect checks, byte/duration/codec
bounds, and transcode a
small preview, scan the actual media and audio, save it in private staging
storage, and expose it only after moderation and publication policy. A separate
creator review/post flow, costs/billing display, accessible previews, lifecycle
cleanup, operational alerts, and production policy/terms review are not in this
change. `ready_for_processing` is not an ad and not a public URL.

## Local verification and deployment boundary

Run `npm ci --ignore-scripts`, then `node --test tests/ai_video_draft.test.mjs`
to check the real migration in PGlite and mocked REST responses. There is no
hosted migration, real Luma call, browser integration or cron in these tests.
After review, an operator may apply only the generated
`migrations/20260923163511_ai_video_draft_jobs.sql` to **adbattle-test** and
deploy only these two Edge Functions there. Review the hosted schema first,
especially `auth.users` and table grants; do not run a broad migration reset.
Configure the staging opt-in and secrets on that project only. Start with one
test user and a manually reviewed prompt; inspect the private job and provider
usage before considering a scheduler.

Provider references: [Luma Agents quickstart](https://docs.agents.lumalabs.ai/),
[Ray 3.2 generation and response](https://docs.agents.lumalabs.ai/guides/videos/generation/),
[Generations REST schema](https://docs.agents.lumalabs.ai/api/resources/generations/methods/create).

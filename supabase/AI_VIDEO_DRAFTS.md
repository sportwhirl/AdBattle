# Staging video draft jobs

This is a **code-only staging scaffold**. Do not apply the migration or deploy
these functions to the production project. The only permitted project is
`adbattle-test` (`nccqnrcdygujulrnwair`). No paid provider call occurs merely
by applying the migration or receiving a user draft request. No generated video
is downloaded, transcoded, displayed, published, or inserted into `ads`.

## Fixed draft contract

| Item | Value |
| --- | --- |
| Provider | Google Gemini Interactions REST API |
| Model | `gemini-omni-1.1-flash` |
| Duration | `10s` |
| Resolution | `360p` |
| Aspect | `16:9` or `9:16` |
| Delivery | `uri`, not inline base64 |
| Execution | `background: true`, `store: true`, `stream: false` |
| Style | `freeform_simple` (default), `pixel_art`, `flat_illustration`, `simple_3d`, `hand_drawn` |
| Prompt | 12–600 normalized characters; text only |

The prompt wrapper asks for simple shapes, restrained detail, and clear motion.
Style is a creative direction, not a guarantee that the provider will obey it.
The output may have a soundtrack. No reference uploads, edit, extension,
photorealistic preset, model override, provider settings, or arbitrary durations
are accepted. Resolution controls dimensions, but the model/provider determines
render time, actual bytes, codec, bitrate and billable video generation. A lower
resolution alone does not prove lower token cost. Treat 10 seconds of generation
as a paid operation even if the output is rejected.

## Request and review flow

`ai-video-draft` is a signed-in user Edge Function (`verify_jwt = true`). It
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
`ADBATTLE_AI_STAGING_ENABLED=video-drafts-v1`. User requests never call Gemini.

The migration's insert trigger serializes quota decisions. It allows one
attempt per user per UTC day and five attempts globally per UTC day. Rejected
and failed jobs still count; another active job also occupies the user's slot
across midnight. The request identity and output choices cannot be edited.
Authenticated users have an owner-only RLS SELECT policy for safe columns and
no direct write privileges. Provider IDs, file URIs, prompts and reviewer names
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
before any public or youth-facing creation feature.

`ai-video-draft-worker` requires a secret header of at least 32 characters,
`x-adbattle-video-worker-secret`, disallows requests with a browser Origin, and
has `verify_jwt = false` because it authenticates the private worker secret.
Provision `ADBATTLE_VIDEO_WORKER_SECRET` and `GEMINI_API_KEY` as Edge Function
secrets only in staging; never put them in frontend config. Its private POST
actions are:

| Action | Body fields | Effect |
| --- | --- | --- |
| `inspect` | `job_id` | Reads exact prompt/hash for review |
| `approve` | `job_id`, `request_hash`, `reviewer`, `review_attestation` | Moves reviewed prompt to `queued` |
| `reject` | `job_id`, `request_hash`, `reviewer` | Rejects without provider call |
| `dispatch` | none | Claims at most one queued job and makes one paid POST |
| `poll` | none | Claims at most one due interaction/file GET |

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
interaction ID fails, the worker retries only that database write, then logs
the job ID and interaction ID for private reconciliation. Do not reset the
status to `queued` or generate a new UUID to work around uncertainty.

The response reader checks `Content-Length` and enforces a 128 KiB streaming
limit before JSON parsing. REST `status` and `model_output` video URI are
validated; the Omni REST `output_video.uri` alias is also recognized. Inline
video data, multiple/conflicting URIs, unknown statuses, unexpected model or
unexpected hosts go to review. Successful completion first waits for Google's
Files API to say `ACTIVE`; only then does the job become
`ready_for_processing`. GET polling can be retried after a lease timeout. The
provider URI remains private in the database, and the public API never returns
it. The worker never downloads or stores video bytes.

**Still to build:** a private processor must retrieve the active file before
provider retention expires, impose byte/duration/codec bounds, transcode a
small preview, scan the actual media and audio, save it in private staging
storage, and expose it only after moderation and publication policy. A separate
creator review/post flow, costs/billing display, accessible previews, lifecycle
cleanup, operational alerts, and production policy/terms review are not in this
change. `ready_for_processing` is not an ad and not a public URL.

## Local verification and deployment boundary

Run `npm ci --ignore-scripts`, then `node --test tests/ai_video_draft.test.mjs`
to check the real migration in PGlite and mocked REST responses. There is no
hosted migration, real Google call, browser integration or cron in these tests.
After review, an operator may apply only the generated
`migrations/20260923163511_ai_video_draft_jobs.sql` to **adbattle-test** and
deploy only these two Edge Functions there. Review the hosted schema first,
especially `auth.users` and table grants; do not run a broad migration reset.
Configure the staging opt-in and secrets on that project only. Start with one
test user and a manually reviewed prompt; inspect the private job and provider
usage before considering a scheduler.

Provider references: [Omni Flash video output and Files API](https://ai.google.dev/gemini-api/docs/omni),
[Interactions REST resource and statuses](https://ai.google.dev/api/interactions-api-v1),
[background execution](https://ai.google.dev/gemini-api/docs/background-execution).

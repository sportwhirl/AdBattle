# Wan2.1 1.3B five-second video drafts (staging)

**Code only, disabled.** The video and adult entitlement migrations are
unapplied in `adbattle-test`. Neither Edge Function nor the GPU worker is
deployed. This path does not create a post or public gallery asset.

## Creation modes

| Mode | Creation | Delivery |
| --- | --- | --- |
| Instant Draft | Animate one or two approved AI stills locally with FFmpeg | Silent five-second 360p MP4, poster and optional separate hover; no video model call |
| Standard Ad | One text-to-video scene from [Wan-AI/Wan2.1-T2V-1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) | Same bounded derivatives; this is the selected model-backed path |
| Enhanced Ad | Two generated scenes edited into a single five-second ad | Planned only; not in the staging queue until cost, timing, moderation and trimming are measured |

No audio is retained. The video model may draw text imperfectly; reliable
typography needs a separate controlled composition stage. Style presets guide
the prompt and do not change the fixed checkpoint, steps, frames or quotas.

## Standard draft contract

- Model: the official Apache-2.0 Hugging Face **Wan2.1 T2V 1.3B** checkpoint,
  downloaded to a private GPU host and served by a pinned LightX2V runtime.
  Configure `--model_cls wan2.1 --task t2v` with the Wan T2V config and the
  1.3B checkpoint. This is self-hosted inference, not the hosted Wan API and
  not a distilled or 14B checkpoint. Use 81 frames at 16 fps and 480p
  (`[480,832]` landscape, `[832,480]` portrait). Model and runtime revisions,
  actual output dimensions and frame rate must be recorded in the GPU smoke
  test. The official unoptimized 4090 benchmark is about four minutes for a
  five-second 480p clip; AdBattle end-to-end latency is unmeasured.
- Input: an authenticated, approved adult staging tester supplies a text
  prompt, preset style, 16:9 or 9:16 aspect and a client request UUID. There
  is **no source image** in this T2V request. The server creates an immutable
  request hash and refuses caller-controlled model, duration, resolution,
  inference steps, seed and media URLs.
- Output: local 480p MP4 processed to silent five-second 360p H.264 (at most
  5 MiB), JPEG poster (at most 100 KiB) and optional separate silent
  three-second 13 fps hover MP4 (400 KiB cap, poster fallback). The original
  and derivatives stay in the private `ai-video-drafts` bucket. The
  `ready_for_processing` state means **awaiting video safety review**, not
  approved for preview, posting or publication.
- Staging quota: one request per user and five globally per UTC day, including
  failed or rejected attempts. These are initial staging caps, not the desired
  eventual allowance of 20 videos per user per day.

## Private flow

1. Review the migrations against the hosted staging schema and apply
   `20260923163511_ai_video_draft_jobs.sql` plus the adult entitlement
   foundation **only** in `adbattle-test`, in reviewed migration order.
   No production apply is part of this branch.
2. `ai-video-draft` (`verify_jwt=true`) checks current Auth identity, a
   server-owned adult tester claim and the exact `ai_video_create`/
   `wan21_t2v` grant. It inserts `pending_review`, with an owner-scoped
   status read. The exact staging URL and `video-drafts-v1` flag gate it.
3. The private `ai-video-draft-worker` review function (`verify_jwt=false`)
   requires `ADBATTLE_VIDEO_WORKER_SECRET` from an operator. `inspect` returns
   the prompt and hash; `approve` or `reject` records an explicit review of
   that hash. The approval attestation is:

   `I reviewed this exact prompt against the AdBattle video safety rules`

4. A private GPU host runs `scripts/wan21_t2v_gpu_worker.py`. The service-only
   `claim_wan21_video_job()` atomically claims one reviewed job. The worker
   rechecks the current Auth adult claim and `ai_video_dispatch`/
   `wan21_t2v` grant, submits **one T2V request without an image** to the
   loopback LightX2V server, polls, processes and privately uploads the media.
   It persists the job UUID as the GPU task ID before the one submission to
   `/v1/tasks/video/`. The runtime preserves this caller-supplied ID.
   Bind the native GPU API to `127.0.0.1`, with a filesystem root shared with
   the bridge. Pin and verify the exact checkpoint and runtime before use.
5. An ambiguous submission leaves `dispatching` or `dispatch_unknown` and is
   never automatically requeued. Inspect GPU tasks, private objects and job
   state before reconciliation. The private local work folder is retained
   under `WAN21_SHARED_ROOT`, with the job UUID in its name, if the outcome
   is uncertain; the GPU may still be writing there. There is no scheduler, final video safety
   scan, creator preview, post RPC or public publication gate in this slice.

The GPU worker needs `SUPABASE_SERVICE_ROLE_KEY`,
`ADBATTLE_AI_STAGING_ENABLED=video-drafts-v1` and `WAN21_SHARED_ROOT` on the
private host. `WAN21_SERVER` can set another loopback port; default is
`http://127.0.0.1:8001`. One worker process per GPU is the starting limit.
These credentials must never appear in frontend config or the repository.

## Capacity and release

Use the [local GPU benchmark](../docs/WAN21_GPU_BENCHMARK.md) for the first
fixed-prompt clip and serial/concurrent comparisons. Its offline tests do not
measure GPU performance; the first real inference is still pending host access.

20,000 videos/day averages 0.231 completed videos/second before peaks,
moderation, retries and processing. At the published four-minute unoptimized
4090 estimate, that is **about 56 continuously busy GPUs at perfect
utilization** for Standard Ad alone. This is arithmetic, not a tested fleet
size or cost quote. A lighter checkpoint lowers memory needs but does not by
itself deliver quick latency at that volume. Benchmark the exact host and
runtime, queue wait, output quality, cost and peak traffic before setting a
turnaround promise or scaling the quota.

Before any public or youth creation, implement age and guardian gates across
all routes, video frame/text/duplicate screening, private owner previews,
immutable ad submission and joint poster/video publication. The live site
and production Supabase project remain outside this staging build.

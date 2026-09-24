# AdBattle AI video architecture

**Status, 2026-09-24:** staging-only code; no hosted video generation, video
posting or gallery playback. The [current draft contract](../supabase/AI_VIDEO_DRAFTS.md)
specifies the selected model and worker. Earlier Luma/ten-second proposals
have been superseded by **five-second Wan2.1 T2V 1.3B** for Standard Ad and
local animation of approved stills for Instant Draft. Enhanced Ad remains a
two-scene design that has not been enabled.

## Current private pipeline

1. A verified adult staging tester requests a text-only draft with a bounded
   prompt, preset style and 16:9 or 9:16 aspect. A service-owned entitlement
   checks `ai_video_create`/`wan21_t2v`. The staging database owns model,
   duration, resolution, quotas, idempotency and pending-review status.
2. A private operator reviews the exact prompt hash. A service-only claim RPC
   atomically moves one approved job to `dispatching`. The private GPU worker
   checks the **current** adult tester claim and `ai_video_dispatch` grant,
   then submits one text-to-video request to a loopback runtime loaded with
   the official Hugging Face `Wan-AI/Wan2.1-T2V-1.3B` checkpoint.
3. The local processor validates the MP4 and produces a silent five-second
   360p full video, small poster, and optional three-second hover. It fits
   Wan's 832×480 or 480×832 native shape without cropping. Originals and
   derivatives stay in private Storage with SHA-256 hashes. A job at
   `ready_for_processing` is still awaiting video content review.
4. An ambiguous GPU submission is never automatically retried. The operator
   reconciles the task and private objects before changing job state.

The offline Instant Draft processor animates one or two approved stills into
the same delivery format. It is not attached to the public API. Prompt
approval and source-image approval do not constitute final-video approval.
There is no audio path or guaranteed in-model typography. A controlled text
overlay can be designed after exact-media safety review is in place.

## Publication invariant

The existing image pipeline holds new posts privately until image safety and
duplicate scans agree on exact bytes. Image publication then copies approved
bytes and atomically sets the public image URL. A future video ad must add
**an independent full-video safety gate**: inspect sampled frames throughout
the clip, visual text and the complete final video, compare the exact original
and derivative hashes, and record the reviewed version. A poster passing the
image scanners must never approve a video ad or move its poster public while
the video review is pending.

A future video-specific database transition must coordinate poster, hover,
full video and ad approval together. Owner previews should use short-lived,
owner-checked private URLs. Gallery playback should load a poster first,
play at most one small muted hover when visible, and fetch full video only
on open. This staging branch contains none of those publication changes.
Wallet, Support and Seed rules remain tied to the existing ad approval state.

## Release work

- Verify the video and adult entitlement migrations against the hosted
  `adbattle-test` schema, then exercise denial and one reviewed adult job on
  a pinned GPU runtime. Measure frame rate, dimensions, quality, latency,
  transcode bytes, queue wait, failure recovery and GPU cost.
- Build final-video safety scanning, immutable owner draft review, joint
  publication, public rendering and the corresponding held/approved cases.
- Complete the [age and guardian contract](AGE_ENTITLEMENT_CONTRACT.md) and
  [youth plan](YOUTH_ACCESS_PLAN.md) across signup, generation, ordinary
  posting and finance before enabling creation for minors or public traffic.

The product goal of 1,000 users making up to 20 videos/day needs a measured
capacity plan. The model card reports roughly four minutes for a five-second
480p clip on an unoptimized RTX 4090, implying about 56 GPUs continuously
busy to produce 20,000 daily clips before traffic peaks and overhead. This
is not a service benchmark or a cost estimate for AdBattle.

# AdBattle AI media: staging specification

Status: proposed product rules and implementation gates, 2026-09-24. The
image draft function is deployed in disabled staging form with 816×816 square
and 1088×608 wide source requests; its codec passed a hosted fixed-fixture
smoke. No real provider image has been generated or posted. Video publishing
is a separate change. The target is creative access for **all ages**, with
parent-controlled access for children. The [youth access plan](YOUTH_ACCESS_PLAN.md)
is a public release gate. Neither AI feature is enabled on the production site.

## Product intent

Give a creator an easy way to turn an original idea into a small, expressive ad.
Simple graphics are an available style, not a restriction. The creator still chooses the
idea, title, caption, and whether to submit the finished ad. Posting remains
irreversible under the existing product rule. Generation alone never posts an
ad or spends the creator's promotion money or a supporter's wallet balance.

The site has two different costs. Generation is charged by the provider's
model, output settings, duration, and actual token use. Gallery bandwidth is
controlled by the files AdBattle serves. Shorter prompts, fewer colors, pixel
art, and downscaling after generation do **not** by themselves guarantee a
lower model bill. Measure actual provider usage before public pricing.

## Provider decision at this checkpoint

| Task | Staging choice | Reason |
| --- | --- | --- |
| Image draft | OpenAI GPT Image 2.5 Flare, low quality | The Images API can use an approved Zero Data Retention project; downscale provider output to the site budget. Minor end users require parent/guardian consent. |
| Exactly 10-second audiovisual model video | Luma Agents Ray 3.2, 360p compatibility probe only | Staging job scaffold only. The output must contain synchronized AI-generated audio or fail processing. Published pricing of $0.18 per 10s draft means 20 cost $3.60 before failures, so this route cannot satisfy the product cost target. Under-13 access needs an explicit provider agreement or another backend. |
| All-ages motion alternative | AI-assisted animation from generated stills | Offline processor implemented for one or two approved JPEG/PNG stills: fixed pan/zoom, cut/dissolve, 10-second 360p derivatives. No account/API/gallery integration yet. It is not freeform model-generated motion. |
| All-ages true audiovisual video research | Self-hosted LTX-2.5 candidate | It generates synchronized video and audio and its community license permits commercial self-hosting under its revenue threshold. GPU cost, latency, low-resolution quality, failure rate, downstream terms, and child-safety operation must be benchmarked before promising 20 accepted drafts per dollar. |
| OpenAI video | Do not start a Sora integration | OpenAI lists the Videos API and Sora 2 shutdown for 2026-09-24 with no replacement. |

Sources: [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation),
[OpenAI under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance),
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data),
[Luma video pricing](https://docs.agents.lumalabs.ai/guides/pricing),
[Luma API terms](https://lumalabs.ai/legal/api-terms-of-use),
[LTX open-source overview](https://docs.ltx.io/open-source-model/getting-started/overview),
[LTX commercial license](https://ltx.io/model/license),
[OpenAI deprecations](https://developers.openai.com/api/docs/deprecations).
Recheck model availability, price, and terms before deployment.

Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) require
users of its API to be at least 18 and prohibit API clients directed toward or
likely to be accessed by people under 18. Gemini is not a fit for AdBattle's
general-audience application under that wording. OpenAI requires guardian
consent for minors; its under-18 guidance requires approved ZDR before
processing under-13/applicable-age personal data. The current staging function
is limited to approved adult testers, which is not a public youth entitlement.
Luma's standard terms say under-13 users are unauthorized, and the API terms
define downstream API users. Do not route a child's request to Luma on a
presumed exception. Confirm teen access, commercial publishing, and 360p
draft-tier output rights in writing before public model video creation.

## Creative format

The initial creation form offers optional **pixel art, flat illustration,
simple 3D, loose hand-drawn, and your own style** directions. A creator may
describe any policy-compliant, imaginative scene or visual style. Low
resolution is a delivery budget, not an artistic genre restriction. A clear
focal subject and contrast are useful guidance because fine detail may become
illegible after downscaling. Photorealistic fictional art is allowed after
review. Deceptive real-person impersonation, named artist imitation, and
copied third-party characters/marks without rights are held or refused. Keep
exact titles, prices, disclosures, and small print in editable HTML
title/caption fields and review them with the visual.

These are creative directions, not a claim that an image with one extra object
or color can be reliably rejected by an automated pixel counter. The hard
technical and publication gates below are enforced separately.

The limits below are the **target public contract**. Staging now creates a
canonical 640px/500KiB JPEG on the server and binds its SHA-256 to the AI ad;
ordinary image uploads can be larger. Both kinds of ad enter private pending
storage and require safety, duplicate, and exact-byte publication checks. A
public all-ages release still needs age and guardian entitlements, review
capacity, hosted verification, and provider approval.

| Asset | Generation request | Public delivery limit | Behavior |
| --- | --- | --- | --- |
| Still image | One low-quality OpenAI image, 816×816 square or 1088×608 near-16:9 source | Canonical JPEG, 640×640 or 640×360, <= 500 KiB; gallery thumbnail target <= 100 KiB | Show a draft first. Publish only after creator chooses it and existing image safety and duplicate checks pass. Preserve the whole wide source frame in the canonical resize. |
| Video | Request one 10-second 16:9 or 9:16 clip with synchronized AI-generated sound; use the lowest native generation profile that passes quality tests | H.264/AAC MP4, 360p delivery, <= 5 MiB; separate poster <= 100 KiB; separate 3–5-second audio-free hover clip, 12–15 fps, target 150–400 KiB and hard cap 500 KiB | Poster loads first. Hover stays silent and starts only after a short delay. Touch or the accessible play button opens the full clip; sound starts only after that deliberate action. |

The video provider's original is kept private for provenance and processing;
the public files are separate derivatives. A transcoded copy may not retain an
invisible provider watermark, so the interface explicitly labels generated
media as AI-created. If the full file or poster cannot meet a public limit,
hold the draft. If only the optional hover file misses its cap, use the still
poster instead. Do not serve a full file through a small CSS box and call that
a preview. The full derivative preserves one normalized AAC soundtrack; the
hover derivative contains no audio. Speech, music, voice, and non-speech sound
must pass a separate transcript/rights/audio-risk review before release.

These public limits are an initial quality budget, not a promise that every
prompt can produce a useful ad. A creator can reject the draft and use an
original upload instead. No automatic costly rerolls.

## Creation and publication rules

1. Only an authenticated, server-approved adult staging tester can request
   generation now. A public release must verify age and guardian entitlements
   on the server for every generation and publication action. Screen the
   freeform prompt against AdBattle's content rules before any paid generation.
   Each request has a stable client request ID. Reserve quota before the provider call;
   a lost response must not buy a second output. One in-flight job per user.
2. Initial staging allowance: 3 image calls per user per UTC day, 30 images
   total per UTC day; 1 video per user and 5 videos total per UTC day when a
   video backend exists. Provider-account spend limits remain an additional
   guard. Failed jobs do not silently retry paid generation.
3. Only text-to-image and text-to-audiovisual-video are in the first version.
   The video model generates its own soundtrack. No uploaded likeness, voice,
   soundtrack, logo, or reference image is sent to a provider.
   Prompt length is bounded, and the server owns the optional style wrapper, model,
   duration, and resolution. Client-supplied settings cannot raise them.
4. The creator reviews the generated draft and may discard it. "Use image"
   selects the completed request ID; posting is a separate, explicit action
   with title and caption. Source and compact derivative stay in private
   storage until approved publication. The browser cannot supply AI post bytes.
5. On submission, the staging server validates exact canonical bytes, owner
   path, MIME/magic, dimensions, file size, and SHA-256 before private pending
   upload at a deterministic owner/request path. An upload error is reconciled
   only by downloading that path and proving both exact bytes and SHA-256;
   retries cannot create a second pending copy. Replay also binds the immutable
   normalized title and caption. Both JPEG/PNG scanners gate image approval.
   The publisher verifies the two scan hashes and fresh private bytes before
   service-only public copy. A generated image receives no moderation shortcut.
6. Video is **not** submitted through the image URL or the image scanner.
   Its future schema, frame/audio review, poster/preview pipeline, and final
   gate must be implemented and tested before video ads can become public.
7. Keep an AI-origin flag and provider/model audit internally. Staging stamps
   the source request ID and canonical derivative hash on the ad; the posted
   image must match before publication. Hosted verification remains a release
   gate for the public badge. Show an
   AI-created label in the page chrome, not burned onto the artwork. Never
   expose a provider key, raw provider errors, or a service-role key to the
   browser.

The image API can produce output that violates these instructions. A provider
filter is only a first layer; AdBattle still reviews the exact final asset
and user text. The existing scanner clearly rejects illegal goods/weapons,
sexual exploitation, hate/extremist recruitment, fraud, and other serious
illegal offers. It holds politics, health/financial claims, gambling,
age-restricted goods, suspicious links, extraordinary guarantees, and
third-party IP concerns for manual review. AI requests for nonconsensual
intimate imagery, deceptive real-person likeness/voice, phishing, or a copied
character/mark without rights are refused or held. Ordinary fictional,
satirical, playful, and noncommercial ideas are allowed within these gates.
If rights or a factual claim cannot be checked automatically, hold it rather
than imply automatic approval. Clearly nonconsensual intimate content and
deceptive impersonation are rejected. No classifier alone establishes permission.

For an all-ages public gallery, a manual hold is not permission to show
age-restricted goods, gambling, adult content, predatory claims, or unsafe
outbound links to children. Review the existing upload/gallery pipeline as
well as generated output before claiming the public feed is suitable for the
youngest audience. Provide reporting, prompt takedown, and child-safety
escalation. Do not send known or suspected CSAM to a general moderation API.

For video, sample frames over the entire clip, inspect visual text and all
scene changes, transcribe all speech, review music/voice/non-speech audio risk,
verify the exact H.264/AAC full derivative and silent hover derivative, and
require a human to watch and listen to the entire final clip in the first
video release. Image-only moderation
cannot certify an entire moving clip. Preserve reviewer reasons and allow
manual resolution without overwriting the original file or audit.

## Branding and provenance

On-site display identifies the creator and has no AdBattle mark on the ad;
the site header may use the AdBattle logo. The current card places the creator
name below the image. If an on-artwork credit or watermark is added, it must
show only the creator, consistently across stills, posters, hover, and full
video. External export is a **new** branded
file containing the approved faint windmill icon and creator credit in its
lower-left blade. Never stamp or overwrite the submitted source or the
creator-only on-site version. The export pipeline has not been implemented in
this branch, so generated-media publication does not silently create it.
The AI-created page label is separate from both watermark versions.

## Engineering sequence and release gate

1. Stage image drafts behind three independent frontend capabilities plus the
   server controls. `aiImageDrafts` gates creation;
   `aiProvenanceReads` preserves AI disclosures even when creation is disabled;
   and `privateMediaPipeline` selects private pending uploads only where that
   backend is already deployed. Keep all three false in production until their
   respective backend prerequisites are present, and never use the creation
   kill switch to hide provenance. Retain the private server key, server quota,
   mocked endpoint tests, and existing post/scan path.
2. Keep the Luma adapter as an adult-only staging compatibility probe, not the
   production cost solution. Build a dedicated audiovisual job, storage, and moderation design
   with an async worker/transcoder. Validate the REST generation ID, status,
   expiring output URL, and media bytes. Test duration and actual 360p billing
   with a real staging key under a small budget only after provider review.
   In parallel, benchmark self-hosted LTX-2.5 at the fixed low-resolution
   profile. At roughly $1 per GPU-hour, the 20-for-$1 target requires at least
   20 accepted ten-second outputs per GPU-hour, including failures and model
   load amortization; do not advertise the target until both portrait and
   landscape runs demonstrate it.
3. Add video-specific schema/RLS, private source and public derivatives,
   gallery rendering, poster-first loading, frame review, and an independent
   publication gate. Test safe and held outputs before any public toggle.
   The offline still animation processor can feed this future video gate after
   the source stills, final clip, and exact bytes are reviewed.
4. Implement the all-ages account, guardian-consent, approved OpenAI ZDR,
   server-entitlement, child-safety, and privacy gates in
   [the youth plan](YOUTH_ACCESS_PLAN.md). A true model-video route for children
   needs provider permission or a separate lawful architecture. Verify
   accessibility, mobile playback, moderation staffing, production spend
   limits, and payment age rules. Production generation remains disabled until
   these gates and hosted checks pass.

Staging changes must never debit the Support wallet, use restricted promotion
funds, or modify the live site or production database implicitly.

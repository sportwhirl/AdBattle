# AdBattle AI media: staging specification

Status: proposed product rules and implementation gates, 2026-09-23. The
image draft feature is the first staging slice; video publishing is a separate
change. The target is creative access for **all ages**, with parent-controlled
access for children. The [youth access plan](YOUTH_ACCESS_PLAN.md) is a public
release gate. Neither AI feature is enabled on the production site.

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
| Exactly 10-second model video | Luma Agents Ray 3.2, 360p candidate | Staging job scaffold only. Published pay-as-you-go price is $0.18 for 10s standard 360p, subject to change. Under-13 access needs an explicit provider agreement or another backend. |
| All-ages motion alternative | AI-assisted animation from generated stills | Offline processor implemented for one or two approved JPEG/PNG stills: fixed pan/zoom, cut/dissolve, 10-second 360p derivatives. No account/API/gallery integration yet. It is not freeform model-generated motion. |
| All-ages true video research | Self-hosted LTX-2.5 candidate | Its community license permits SaaS within conditions and has no stated end-user age floor. GPU cost, latency, output quality, downstream terms, and child-safety operation need validation before choosing it. |
| OpenAI video | Do not start a Sora integration | OpenAI lists the Videos API and Sora 2 shutdown for 2026-09-24 with no replacement. |

Sources: [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation),
[OpenAI under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance),
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data),
[Luma video pricing](https://docs.agents.lumalabs.ai/guides/pricing),
[Luma API terms](https://lumalabs.ai/legal/api-terms-of-use),
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

The limits below are the **target public contract**. The staging browser
converts an AI draft to a 640px/500KiB JPEG, but the existing post endpoint
and image scanner accept larger ordinary uploads; the AI-origin trigger does
not yet bind the posted bytes cryptographically to the private draft. A server
check of exact dimensions, size, and provenance is required before public AI
creation. Current ordinary posts upload to a public bucket before scans run;
an all-ages release also requires private pending media and an age-suitable
review gate for every ad, including non-AI uploads.

| Asset | Generation request | Public delivery limit | Behavior |
| --- | --- | --- | --- |
| Still image | One low-quality OpenAI image, square or wide; provider output exceeds delivery dimensions | JPEG or PNG, longest edge <= 640 px, <= 500 KiB; gallery thumbnail target <= 100 KiB | Show a draft first. Publish only after creator chooses it and existing image safety and duplicate checks pass. |
| Video | Request one 10-second 16:9 or 9:16 clip at 360p; verify actual duration and frame rate | Silent H.264 MP4, 360p, <= 5 MiB; separate poster <= 100 KiB; separate 3–5-second muted hover clip, 12–15 fps, target 150–400 KiB and hard cap 500 KiB | Poster loads first. Hover starts after a short delay, only one in view plays, and leaves stop playback. Touch requires a tap. Full clip loads only on opening. |

The video provider's original is kept private for provenance and processing;
the public files are separate derivatives. A transcoded copy may not retain an
invisible provider watermark, so the interface explicitly labels generated
media as AI-created. If the full file or poster cannot meet a public limit,
hold the draft. If only the optional hover file misses its cap, use the still
poster instead. Do not serve a full file through a small CSS box and call that
a preview. Video audio is stripped in the first version;
speech/music needs a separate rights and moderation path before release.

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
3. Only text-to-image and text-to-video are in the first version. No uploaded
   likeness, voice, soundtrack, logo, or reference image is sent to a provider.
   Prompt length is bounded, and the server owns the optional style wrapper, model,
   duration, and resolution. Client-supplied settings cannot raise them.
4. The creator reviews the generated draft and may discard it. "Use image"
   attaches a compact JPEG to the existing form; posting is a separate,
   explicit action with title and caption. Generated draft bytes stay private
   or in browser memory until that action, not in the public ad bucket.
5. On submission, the public version must validate exact bytes, owner path,
   MIME/magic, dimensions, file size, and immutable ad data **server-side**.
   The current staging slice relies on browser compression for the 640px/
   500KiB AI draft budget; a server gate and source-byte binding are still
   missing. The existing JPEG/PNG duplicate and safety scanners gate image
   approval, but pending ordinary uploads are already publicly addressable.
   Move them to private storage before an all-ages release. A generated image
   receives no moderation shortcut.
6. Video is **not** submitted through the image URL or the image scanner.
   Its future schema, frame/audio review, poster/preview pipeline, and final
   gate must be implemented and tested before video ads can become public.
7. Keep an AI-origin flag and provider/model audit internally. The image
   staging slice verifies that a completed draft belongs to the creator, but
   browser recompression means its posted bytes are not yet cryptographically
   bound to the private source. Exact checksum binding is a release gate for
   public provenance claims. Show an
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
scene changes, verify the silent public derivative, and require a human to
watch the entire final clip in the first video release. Review any retained
source audio before any future audio-enabled release. Image-only moderation
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

1. Stage image drafts behind a staging-only feature flag, private server key,
   server quota, mocked endpoint tests, and the existing post/scan path.
2. Make a dedicated Luma candidate video job, storage, and moderation design
   with an async worker/transcoder. Validate the REST generation ID, status,
   expiring output URL, and media bytes. Test duration and actual 360p billing
   with a real staging key under a small budget only after provider review.
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

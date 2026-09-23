# AdBattle AI media: staging specification

Status: proposed product rules and implementation gates, 2026-09-23. The
image draft feature is the first staging slice; video publishing is a separate
change. Neither feature is enabled on the production site by this document.

## Product intent

Give a creator an easy way to turn an original idea into a small, expressive ad.
Deliberately simple graphics are part of the look. The creator still chooses the
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
| Image draft | Gemini 3.1 Flash Lite Image, one 1K output | Published rate is about $0.0336 per image plus input; Google offers a fast 1K model. |
| Exactly 10-second video | Gemini Omni 1.1 Flash, 360p request | Supports 3–10 seconds and a 360p output setting. Published 720p effective rate is about $0.10/second; 360p bill must be measured. |
| OpenAI image alternative | GPT Image 2.5 Flare, low quality | Valid fallback if Gemini terms, quality, or cost do not fit; its minimum generated area is greater than a 640×360 display copy. |
| OpenAI video | Do not start a Sora integration | OpenAI lists the Videos API and Sora 2 shutdown for 2026-09-24 with no replacement. |

Sources: [Google image guide](https://ai.google.dev/gemini-api/docs/image-generation),
[Google Omni guide](https://ai.google.dev/gemini-api/docs/omni),
[Google pricing](https://ai.google.dev/gemini-api/docs/pricing),
[OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation),
[OpenAI deprecations](https://developers.openai.com/api/docs/deprecations).
Recheck model availability, price, and terms before deployment.

Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) require
users of its API to be at least 18 and prohibit API clients directed toward or
likely to be accessed by people under 18. AdBattle has no established age
gate. Keep the integration confined to adult-operated, local staging until a
public-audience route is settled; an adult-only button on an otherwise open
site is not assumed to resolve that wording. The same terms describe the API
as for professional/business development, not consumer use. AdBattle's public
creator use case needs a provider-terms review on both points. Confirm the
account's paid tier and regional availability before using a real key.

## Creative format

The initial creation form offers **pixel art, flat illustration, simple 3D,
and loose hand-drawn** presets, plus an **other simple style** option. A
creator may describe imaginative scenes in any of these modes; no single
house style is imposed. The wrapper requests one clear idea, a bold focal
subject, simple background, readable contrast, and little fine texture.
Photorealistic impersonation, named artist imitation, and copied third-party
characters are not offered as presets. Do not require the model to put the
title, price, disclosures, or small print inside pixels. Keep exact ad words
in the editable HTML title/caption fields and review them with the visual.

These are creative directions, not a claim that an image with one extra object
or color can be reliably rejected by an automated pixel counter. The hard
technical and publication gates below are enforced separately.

| Asset | Generation request | Public delivery limit | Behavior |
| --- | --- | --- | --- |
| Still image | One 1K image, 1:1 or 16:9 | JPEG or PNG, longest edge <= 640 px, <= 500 KiB; gallery thumbnail target <= 100 KiB | Show a draft first. Publish only after creator chooses it and existing image safety and duplicate checks pass. |
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

1. Only an authenticated staging creator can request generation. Screen the
   freeform prompt against AdBattle's content rules before any paid generation.
   Each request has a stable client request ID. Reserve quota before the provider call;
   a lost response must not buy a second output. One in-flight job per user.
2. Initial staging allowance: 3 image calls per user per UTC day, 30 images
   total per UTC day; 1 video per user and 5 videos total per UTC day when a
   video backend exists. Provider-account spend limits remain an additional
   guard. Failed jobs do not silently retry paid generation.
3. Only text-to-image and text-to-video are in the first version. No uploaded
   likeness, voice, soundtrack, logo, or reference image is sent to a provider.
   Prompt length is bounded, and the server owns the style wrapper, model,
   duration, and resolution. Client-supplied settings cannot raise them.
4. The creator reviews the generated draft and may discard it. "Use image"
   attaches a compact JPEG to the existing form; posting is a separate,
   explicit action with title and caption. Generated draft bytes stay private
   or in browser memory until that action, not in the public ad bucket.
5. On submission, validate exact bytes, owner path, MIME/magic, dimensions,
   file size, and immutable ad data. The existing JPEG/PNG duplicate and
   safety scanners gate image publication. A generated image receives no
   moderation shortcut.
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
2. Make a dedicated video job, storage, and moderation design with an async
   worker/transcoder. Validate Google's REST `steps` response and media bytes;
   do not rely on SDK-only `output_video`. Test 10-second duration and actual
   360p billing with a real staging key under a small budget.
3. Add video-specific schema/RLS, private source and public derivatives,
   gallery rendering, poster-first loading, frame review, and an independent
   publication gate. Test safe and held outputs before any public toggle.
4. Resolve the Gemini API audience terms, public generation payment/quota,
   accessibility and mobile playback, support moderation staffing, and
   production spend limits. Until these decisions and hosted checks pass,
   production generation stays disabled.

Staging changes must never debit the Support wallet, use restricted promotion
funds, or modify the live site or production database implicitly.

# AdBattle: all-ages creative access plan

**Status (2026-09-23):** product target and release gates. The current branch is
staging-only and permits approved adult testers; it does not establish a child
account, parental-consent flow, Zero Data Retention (ZDR), or a public video
publishing path. The existing signup, ordinary image posting, Support, Seed,
and wallet endpoints also have **no age entitlement**, and ordinary pending
image uploads use public storage before scanning. Public AI creation remains
off until the applicable gates are implemented and verified. The current site
must not be presented as child-safe. This plan needs review for each launch
jurisdiction.

## Product rule

People of every age should be able to enjoy approved AdBattle creations. The
target is to let children create as well, with parent-controlled access where
required. Age changes the account, privacy, spending, and review workflow; it
does not force every artist into one pixel-art style. The public gallery must
be suitable for its youngest intended audience.

| Audience | Target access once gates pass | Until then |
| --- | --- | --- |
| Visitor of unknown age | View only approved, age-suitable gallery media with privacy-safe defaults. | Current site needs a tracking/content audit before claiming this is child-safe. |
| Under 13, or below local digital-consent age | Parent-approved account can draft an image with an approved ZDR OpenAI project. AI-assisted motion from those images can be a lightweight 10-second option. Publication requires review and parent controls. | AI creation is off. Existing signup/post/wallet paths are **not yet age gated**; block or redesign those paths before inviting children to use them. Gallery privacy/content review is pending. |
| 13–17 | Parent/guardian permission for AI API use; server-verified creative entitlement, enhanced safeguards and publication review. Full model-video creation requires a provider agreement that covers this age band. | Restricted adult-tester staging only. |
| 18+ | Normal creator path after the public media, abuse, and payment gates pass. | Restricted adult-tester staging only. |

The image route is OpenAI's Images API. Its Services Agreement requires
parent/guardian consent for minor end users, and its
[under-18 API guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance)
says to implement ZDR before processing personal data of under-13 children or
children below the applicable digital-consent age. The Images API with
`gpt-image-2.5-flare` is
[ZDR-compatible](https://developers.openai.com/api/docs/guides/your-data), but ZDR requires
**prior OpenAI approval and project configuration**. A `store:false` flag or
removing a name from the UI does not grant ZDR. Apply the same child-safe path
to text moderation and policy-review calls that receive a child's prompt or
personal data; verify the entire request chain's eligibility. Do not send raw
birth dates, parent contact details, email addresses, or account IDs to a model.

Do not use Gemini in this general-audience app: its
[API terms](https://ai.google.dev/gemini-api/terms) prohibit an API client likely to be
accessed by under-18s, even when the API credential stays on the server. The
proposed Luma Ray 3.2 video adapter remains staging-only. Luma's
[individual terms](https://lumalabs.ai/legal/terms-of-service) say under-13
users are unauthorized, and its
[API terms](https://lumalabs.ai/legal/api-terms-of-use) define downstream API users and
bar prohibited data. Do not route a child's request through Luma on an
assumption that stripping personal information cures the age restriction.
Obtain written provider permission covering the actual ages, public commercial
output, and 360p draft-tier publishing, or use an approved alternative. Its
teen use also needs confirmation under the chosen account agreement.

## Child account and consent boundary

1. Put a neutral age screen before account creation, user-generated content,
   analytics identifiers, or other personal-data collection from a child.
   Design this with counsel for whether the site is general or mixed audience
   in each market. Keep only the age band and the minimum evidence needed; do
   not expose date of birth in public profiles or provider requests.
2. For an under-13 account, give the parent direct notice, obtain **verifiable
   parental consent before** collecting, using, or disclosing the child's
   personal information for the approved features, and record consent scope,
   method, time, and revocation. Provide a parent view to inspect, delete, and
   stop further collection. Use a vetted age/consent service or an FTC-accepted
   verification method. Revisit local digital-consent ages outside the US.
3. For all minors using OpenAI generation, record guardian permission under
   the API agreement. Any payment, promotion spend, creator payout, or
   advertising consent is **separate** from creative permission. Keep child
   wallet and payout features unavailable until an adult-controlled design and
   payment-provider review are implemented. Do not make child participation
   contingent on a payment or more data than necessary.
4. Store a server-owned entitlement (age band, approved features, guardian
   scope, expiry/revocation, and provider eligibility) behind RLS. Recheck it
   at generation reservation, worker dispatch, draft preview, upload, and
   publication. A browser checkbox or user-editable JWT metadata never grants
   the entitlement. Revocation blocks new calls and publication immediately;
   define retention/deletion for already held drafts. Existing accounts must
   be classified safely before a public switch.
5. Keep pending uploads in private storage until the exact media and text pass
   age-suitable review, then atomically publish approved derivatives. The
   current public `ad-images` upload happens before scanners run, so an
   unlisted pending URL is not private. Migrate ordinary uploads as well as AI
   media; handle rejected assets and stale CDN copies explicitly.
6. Use contextual display only for children. Audit cookies, analytics,
   embedded media, storage/CDN logs, public creator handles, outgoing links,
   and any advertising or third-party scripts. Under COPPA, a persistent
   identifier may be personal information; disclosure for targeted advertising
   requires separate parental opt-in. Set finite retention and deletion for
   child prompts, drafts, audit evidence, and published assets.

These are implementation gates, not a claim that the present site complies
with COPPA. See the
[FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)
and [2025 amended rule summary](https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data).

## Creative and safety boundary

- Keep open-ended prompts and optional pixel, flat, sketch, 3D, and custom
  styles. Photorealistic fictional art is possible after the same review; low
  delivered resolution is a bandwidth cap, not a rule against detailed ideas.
  Test legibility rather than promising a model will obey every style request.
- Do not accept reference uploads, requests depicting an identifiable real
  person or voice, private contact/location details, or a child's photo in the
  initial generation path. Fictional photorealistic people remain allowed.
  Those are separate consent, rights, and privacy projects. Screen prompts
  before a paid call and screen exact output, title/caption, and video frames
  before publication. Hold ambiguous claims and rights issues for human
  review. A provider's filter does not certify the ad.
- Disallow sexual content involving minors, grooming, nonconsensual intimate
  material, threats/harassment, deceptive impersonation, and illegal offers.
  Keep public ads suitable for children: no age-restricted goods or services,
  gambling, adult content, predatory financial/health claims, or unsafe
  outbound links. Add user reporting, rapid takedown, repeat-abuse controls,
  reviewer escalation, and a documented response route for suspected child
  exploitation. Do not submit known or suspected CSAM to a general moderation
  endpoint; follow the provider's
  [child-safety guidance](https://developers.openai.com/api/docs/guides/csam-guidance).
- Show an AI-created label in site chrome and a clear draft review before the
  explicit, immutable post action. For the first under-13 release, require a
  parent's approval of the exact title, caption, and media before public
  submission. Keep private drafts out of gallery
  storage. Review age suitability of *all* existing and newly uploaded ads,
  not just AI output.

## Low-bandwidth all-ages video route

The current Luma job scaffold must not serve children under 13. A useful
near-term fallback is **AI-assisted animation**: generate one or two original
stills via the approved ZDR image path, then make a deterministic ten-second
silent motion piece (pan, zoom, cut or dissolve). An [offline processor]
(STILL_ANIMATION_PROCESSOR.md) now demonstrates this with bounded 360p
MP4/poster/hover files. It is **not connected** to user accounts, generation,
review, or the gallery; a child-facing worker and final-video review are still
to build. It lets a child choose a scene, look, and motion without a video
model call. Exact title/caption text remains editable in the ad form. It will
not create arbitrary model-directed motion.
Full generative video becomes available to that age group only with a provider
contract or another lawful, verified architecture; adult/teen model video may
be enabled separately once its own provider and publication gates pass.

One candidate for true generated motion is **self-hosted LTX-2.5** on
AdBattle-controlled GPU infrastructure. Its
[community license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) expressly permits
remote SaaS hosting and has no stated minimum end-user age, but requires
enforceable downstream content restrictions and AI disclosures. Commercial
use below $10 million in annual entity revenue is permitted without a model
license fee; at or above that threshold a paid agreement is required. These
are licensing observations, not a child-use clearance. Review the bundled
model notices, parent agreement, and COPPA obligations before implementation.
LTX's official model materials require substantial GPU memory and downloads;
its actual ten-second latency, quality at 360p, and per-clip GPU cost have
**not** been measured for AdBattle. Do not promise a cheap or fast child video
model until a bounded staging benchmark proves it.

## Public release checklist

- Age screen and server entitlement, verifiable parent flow, terms/notice,
  parent controls, withdrawal and deletion are operational and tested.
- OpenAI has approved ZDR for the actual project; Images and every child-data
  safety call use eligible endpoints/models. Provider keys stay server-side.
- Child content review, reporting, moderation staffing, audit and emergency
  response are tested; existing gallery and outgoing links pass the same
  youngest-audience standard.
- Upload, posting, wallet, Support, Seed, promotion, and payout paths honor the
  age entitlements server-side; no cross-user or browser override works. The
  existing public-bucket-before-scan path is replaced with private pending
  media and exact-byte review. The 640px/500KiB image publication budget is
  enforced on the server, not only by the browser's draft conversion.
- Video jobs remain disabled for an age band until its provider confirms the
  route in writing and full-video scanning/publication is tested. Do not
  present the draft scaffold or offline FFmpeg processor as a public feature.
- Verify blocked, revoked, expired, race, and mismatched-guardian cases with
  real staging accounts. Review US and launch-region requirements before
  production enablement.

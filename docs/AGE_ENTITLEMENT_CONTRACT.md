# AdBattle age and guardian entitlement contract

**Design status — 2026-09-23.** This is a proposed implementation contract for
an all-ages AdBattle. It is not a claim that the current site is suitable for
children or that AI creation, posting, or payments are cleared for them. No
hosted migration, consent provider, OpenAI Zero Data Retention (ZDR) approval,
or production age gate is included here. Apply this alongside
[the youth access plan](YOUTH_ACCESS_PLAN.md), with launch-jurisdiction legal
review before a public switch.

## Product and trust boundary

Visitors of any age may eventually view only approved, age-suitable ads with
privacy-safe defaults. A person below the local age of digital consent may
create only after a guardian has received direct notice and given verifiable
consent. Every minor using OpenAI generation needs guardian permission under
the [OpenAI Services Agreement](https://openai.com/policies/services-agreement/).
For a child under 13 or the applicable digital-consent age, OpenAI says to
implement ZDR **before** sending personal data to its API. ZDR itself requires
OpenAI's prior approval and project configuration; the images endpoint's ZDR
eligibility is not approval for AdBattle. Check the entire prompt, moderation,
and image request chain for eligible endpoints and model limitations.

An age checkbox, a client-side flag, or a user-editable JWT claim cannot grant
any capability. All write authorization is based on a current, server-owned
database entitlement. The browser may read a sanitized capability summary to
draw controls, but its value is never accepted as proof. In particular,
Supabase warns that `user_metadata` is editable by the user and JWT contents
can remain stale until refresh; revocation-sensitive checks must query current
state.

## Minimum private state

Keep these tables in a non-exposed schema, with explicit grants and RLS. Only
trusted backend code may set age or consent state. Names below are proposed;
their columns and constraints are the API contract, not ready-to-run SQL.

| Entity | Required fields and invariant |
| --- | --- |
| `age_tickets` | Opaque one-use proof hash, age band (`below_local_consent`, `minor_eligible`, `adult`), jurisdiction and threshold version, issuance/expiry/consumption, assessment method. Do not retain raw birth date. The neutral screen can ask month and year; classify a boundary month conservatively or ask for a fresh assessment. Redact inputs from logs. A below-threshold ticket contains no child email or profile. |
| `age_entitlements` | `user_id` unique, age band, jurisdiction, state (`pending`, `active`, `blocked`, `revoked`), assessment method/time, `version`, expiry, created/updated timestamps. Existing accounts without a row have **no write capabilities** until classified. Reassessment is required when moving age bands; avoid deriving birthdays from a stored date of birth. |
| `guardian_links` | `child_user_id`, `guardian_user_id`, status, verification vendor/method and opaque verification reference, verified time and expiry. The guardian is an independently authenticated adult. Do not store identity document images in AdBattle. One adult proof does not automatically approve every child action. |
| `guardian_consents` | Child and guardian IDs, distinct `scope`, notice/terms version, method, verified proof reference, granted/expiry/revoked timestamps and audit version. Unique active scope per child; an old consent cannot revive after revocation. Initial scopes: `account_and_private_draft`, `openai_image`, `public_posting`; reserve a separate `third_party_disclosure` scope when required. Financial scopes remain unavailable in the first youth release. |
| `parent_ad_approvals` | Guardian/child/draft IDs, SHA-256 digest of **the exact media bytes and canonical title, caption, creator handle, link, and promotion metadata**, associated consent version, approved/expiry/consumed timestamps. Any edit or replacement invalidates approval. This per-ad approval for under-13 publication is an AdBattle safety rule. |
| `youth_audit_events` | Minimal actor, subject, action, result, policy version and time; no prompt text, raw ID document, or birth date. Apply documented retention, access and deletion rules. Maintain a separate accounting record only where legally required. |

Use a private, service-only `can_act(subject_user_id, action, resource_id)`
predicate or equivalent common library. It evaluates current age state, guardian
scope and verification expiry, current policy and provider flags, and the
resource owner/content digest in one transaction. Server routes authenticate
the JWT, derive `subject_user_id` from that identity, and never trust a caller
supplied user ID. For direct Data API writes, enforce equivalent checks in RLS
and trusted database transitions. Limit `SECURITY DEFINER` helpers to a
non-exposed schema, revoke default `PUBLIC` execution and test cross-user
calls. A worker using `service_role` must perform the same check itself.

## Action gate matrix

`Unknown` includes existing accounts until they complete the age flow.
Financial actions for all minors are intentionally deferred; a guardian's
separate adult account may be evaluated under its own payment rules later.

| Action | Unknown visitor/account | Adult | 13–17 (or above local threshold) | Below local consent age |
| --- | --- | --- | --- | --- |
| View gallery | Approved, youngest-audience-safe media; no behavioral tracking | Same | Same | Same |
| Register and edit profile | Neutral age assessment first; unknown legacy account read-only | One-use age proof | Age proof; guardian permission before OpenAI use; age-safe public handle | Guardian-initiated setup and verified consent **before** child Auth account/profile data |
| Upload, private draft, AI image | Deny | Auth + quota + private storage + scan | Active creation permission + youth controls | Verified account/draft and OpenAI scopes, approved ZDR project, private storage and all child-data safety calls eligible |
| Submit or publish an ad | Deny | Exact-media scan and publication transition | Active permission + youth review | Active public-posting scope + parent approval of exact digest + human age-suitability review |
| AI video | Deny | Existing staging gate until provider and media review pass | Provider agreement and safety gate first | Only approved local animation route after image/guardian gates; no Luma call under current terms |
| Support, Seed, wallet top-up | Deny | Current payment checks plus entitlement | Disabled pending guardian-controlled payment design and payment-provider review | Disabled |
| Stripe Connect/payout | Deny | Existing payment checks plus entitlement | Disabled until an adult representative and Stripe onboarding are implemented | Disabled: Stripe accounts require age 13+ |

The apparent 13–17 band is not a universal legal age. Resolve the local
digital-consent age by supported jurisdiction and apply the stronger child
route where necessary. Adult self-report is not a guarantee of age; choose
stronger assurance if the jurisdiction or risk assessment requires it. Do not
describe a neutral age screen as a substitute for parental consent.

## Endpoint and lifecycle contract

1. **Assess age before signup and tracking:** `POST /age/assess` accepts birth
   month/year and jurisdiction over TLS, derives the age band server-side,
   discards raw inputs and returns a short-lived one-use ticket. Do not ask
   leading questions that encourage an older answer. Prevent Supabase direct
   signup/OAuth bypass with a server-controlled creation path and/or a
   `before-user-created` hook that verifies and consumes the ticket. The hook
   may read a user-supplied ticket string, but must validate it against private
   server state; a claimed age in metadata is not proof. Audit all existing
   Auth entry points and make unclassified existing users read-only before
   enabling youth enrollment.
2. **Get guardian consent:** `POST /guardian/start` lets a verified adult begin
   a child account flow and sends direct notice listing the data, purposes,
   processors, public-disclosure choices, retention, operator contact details,
   and parent rights, with a linked child privacy notice. Before
   consent, collect only the narrow contact information needed to obtain it
   under a valid exception; delete abandoned contacts after a reasonable
   time. `POST /guardian/verify` consumes a signed callback from a vetted
   verification provider or an FTC-recognized method. A mere email click,
   checkbox, or credit card number without the required safeguards does not
   verify a parent for public posting. `POST /guardian/consent` records each
   versioned scope and only then creates/activates the child account. Use an
   alternative verification method for parents who cannot use the primary.
3. **Query capabilities:** `GET /me/capabilities` returns booleans and reason
   codes for UI only. All route/database checks call `can_act` afresh. A
   global provider-eligibility flag must confirm actual OpenAI ZDR approval
   for the child project; no user consent can override a disabled provider.
   Recheck at quota reservation, paid model dispatch, draft delivery, private
   upload, publication, and any delayed/retried worker.
4. **Approve exact publication:** `POST /parent/approve-ad` requires the
   guardian's authenticated session and a frozen private draft. The parent
   sees exact image/video and text plus the promotion terms and outbound link.
   Store the digest; `POST /ads/submit` checks the current consent and digest
   in the same transaction as status change. A scanner passing by itself never
   publishes. No child content is in public storage before scan and approval.
5. **Revoke, review, delete:** `POST /parent/revoke` atomically increments the
   entitlement version and revokes relevant scopes, preventing new writes,
   dispatch, submission and payout. Cancel queued work, hide affected public
   content when needed, stop future promotion, then run a bounded deletion
   workflow for child data and drafts. A worker checks the version immediately
   before an external API call and again before publishing. An already sent
   request cannot be recalled; do not retry it after revocation. Provide a
   parent dashboard to review data, refuse further collection, request
   deletion, and report content. Necessary payment/accounting records, if any,
   require a separate minimization and retention review. AdBattle's usual
   immutable-ad rule cannot block a parent's privacy request or moderation
   takedown.

The FTC lists several verifiable-consent methods, including a signed returned
form, card in a monetary transaction, staffed phone/video, and qualifying ID
verification. Its email-plus/text-plus methods are limited to an operator
that does **not** disclose children's personal information; AdBattle's public
creator content means those are an unsafe default. A vendor's identity proof
must be bound to the actual guardian and child consent record, with signed
callbacks and replay protection. Obtain written service-provider security
assurances and retain only the minimum proof reference.

## Existing AdBattle bypasses to close

| Route or data path | Current behavior | Server-side change before youth release |
| --- | --- | --- |
| `index.html` `signup()` / Auth | Email/password signup has no age input; login restores full UI. | Neutral pre-signup flow plus Auth creation hook/server registration; deny unclassified writes even if an Auth user exists. |
| `index.html` `postAd()` and `public.ads` | Browser uploads into public `ad-images` before scan and inserts `ads` directly; owner-only INSERT policy does not check age. | Private pending bucket with service-controlled promotion of exact approved bytes; RLS/trusted insert with entitlement and parent digest checks. |
| `saveCreatorHandle()` / `creator_profiles` | Any authenticated owner can write a publicly readable handle. | Age-safe handle defaults and policy; guardian/public identity scope and moderation. |
| `scan-ad`, `scan-ad-duplicate`, `refresh_ad_moderation_status`, public gallery RPCs | Scanner sends title/caption/image to OpenAI and passes safety/duplicate; passing rows become public. | ZDR-eligible child-data scan path, youngest-audience review, current entitlement and parent exact-digest check at publication; public RPC includes only cleared state. |
| `generate-ai-image`, `reserve_ai_image_draft`, `set_ad_ai_origin` | Staging adult tester check; draft ownership but no youth consent. Uploaded posted bytes are not bound to draft source hash. | Check entitlement before spend and signed draft URL; bind generated output to posted bytes and recheck before submit. |
| `ai-video-draft` / worker | Staging adult gate; async job can outlive request. | Recheck consent/version before provider dispatch and final delivery; no under-13 Luma path. |
| Wallet checkout, `support-from-wallet`, paid Seed, direct Support webhook, settlement | Auth/payment/ledger controls exist but no age restriction; delayed webhooks and payout worker continue independently. | Adult-only financial entitlement at entry and ledger transition; review pending payments, refunds, holds and payout when age state changes. |
| Stripe Connect creation/status | Frontend invokes deployed functions absent from this checkout. | Inspect deployed source, gate Connect and payout for age and guardian representative before minor support is considered. |

## Staged implementation and release evidence

1. **Foundation in staging:** define notices, jurisdiction matrix, retention
   and incident owners; audit the existing gallery, outbound links, cookies,
   CDN and analytics. Add private schema, explicit RLS/grants, age tickets,
   Auth hook and common `can_act` checks. Backfill existing users as unknown;
   test direct API bypass and stale JWT/revocation without disrupting the
   current public site.
2. **Guardian flow and private media:** integrate a suitable verifiable
   consent method; implement parent review/revoke/delete and exact-ad
   approval. Move *ordinary and AI* pending uploads to private storage,
   rescan original/final bytes and require a trusted publish transition.
   Review all historical approved ads before promising a child-safe gallery.
3. **AI image release gate:** obtain OpenAI approval and turn on ZDR for the
   actual project; confirm generation and every moderation/review call are
   eligible. Test under-13 personal-data cases, 13–17 guardian permission,
   provider errors, race/retry/revocation, content reporting and takedown.
   Keep youth payment actions off. The low-resolution 640px/500KiB cap needs
   a server check; it is a delivery budget, not a restriction on creativity.
4. **Video and money separately:** connect the local still-animation route
   only after private-media/consent gates. True model video needs a provider
   whose terms cover the actual ages and a reviewed worker/publication path.
   Review youth Support/Seed/wallet economics, Stripe Connect adult
   representative, tax and payment rules before granting any minor financial
   capability. Test one end-to-end staging child account with a verified
   guardian, then a revocation during a queued job, before any public switch.

## Primary references

- [FTC COPPA rule, 16 CFR Part 312](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312): notice/consent (§§312.4–5), review/refusal/deletion (§312.6), security (§312.8), retention (§312.10).
- [FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions): neutral age screens, parent verification methods, photos/video, and public posts.
- [FTC February 2026 age-verification policy](https://www.ftc.gov/news-events/news/press-releases/2026/02/ftc-issues-coppa-policy-statement-incentivize-use-age-verification-technologies-protect-children): narrow age-only processing conditions.
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/), [under-18 API guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance), and [API data controls](https://developers.openai.com/api/docs/guides/your-data).
- [Stripe Services Agreement](https://stripe.com/legal/ssa): Stripe account age and adult representative; this is about account/Connect eligibility, not a blanket statement about child consumer purchases.
- [Luma individual terms](https://lumalabs.ai/legal/terms-of-service) and [API terms](https://lumalabs.ai/legal/api-terms-of-use): proposed staging video route, subject to separate provider review before youth use.
- [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security), [Before User Created hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook), and [Data API grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

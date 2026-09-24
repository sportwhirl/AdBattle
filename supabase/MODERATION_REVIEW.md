# Private moderation review

`moderation.html` is a separate operator page. The static page is public to load;
its queue, findings, history, and decisions require a current moderator account.
It reuses `frontend-config.js` and the existing ordinary Supabase Auth session.
No service-role key, scanner secret, or Stripe credential belongs in this page.

## Current private-image staging integration

The private-media integration targets `feat/ai-media-integration`. It brings in
the existing moderator page and adds `moderator-ad-previews` so reviewers can
inspect uploads in the private `ad-pending-images` bucket. It introduces no new
database migration or moderator grant. In the existing **adbattle-test** project,
the moderation and private-pending-image migrations are already applied; do not
rerun them for this update.

After merging the integration PR:

1. Deploy only `moderator-ad-previews` to project `nccqnrcdygujulrnwair`, with JWT
   verification enabled as specified in `supabase/config.toml`. Its package
   includes `_shared/http.ts` and `_shared/storage-scan-policy.ts`.
   It uses Supabase's supplied `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` inside the function. No privileged key is entered
   in the browser. The existing staging CORS configuration must allow the exact
   `http://localhost:8000` origin.
2. In the existing local checkout, update the integration branch:

   ```sh
   cd /home/sportwhirl/AdBattle-staging
   git switch feat/ai-media-integration
   git pull --ff-only origin feat/ai-media-integration
   ```

3. Keep the staging server running and reload
   **http://localhost:8000/moderation.html**. Confirm the staging label, sign in
   with the existing authorized moderator, and open a held ad. Both its image
   and its matched image must load before the decision controls become usable.
4. Check the same preview request using an ordinary account: it must be denied.
   Leave pending ads unchanged until an operator deliberately records a review.

Clearing the last human review queues image publication. The ad remains private
and `pending_scan` until the existing publisher verifies and publishes its
approved bytes. A publisher failure is not a reason to bypass this gate.

## Initial moderation setup (new environments only)

1. Merge the review PR into `wallet-ledger-90-10` and pull that branch locally.
2. In **adbattle-test** (`nccqnrcdygujulrnwair`) apply only
   `migrations/20260923164716_private_moderation_review.sql` after the existing
   duplicate-screening migration. Do not rerun older migrations. This change
   does not require a scanner or wallet Edge Function deployment.
3. Keep `moderation_private` **out of the Data API exposed schemas**. Only
   the four `public.moderator_*` invoker functions are API entry points.
4. In Supabase Auth, identify the intended moderator's existing, non-anonymous
   user UUID. An administrator grants access in SQL Editor using the template
   below. The migration deliberately grants nobody access, and the page cannot
   grant roles. Do not substitute an email or trust a user's profile metadata.
5. Start the existing staging server. Visit
   **http://localhost:8000/moderation.html** and sign in with that account.
   Confirm the **ADBATTLE TEST · LOCAL STAGING** label before reviewing.

Grant template (replace all three values deliberately):

```sql
insert into moderation_private.reviewers(user_id,granted_by,reason)
values (
  'REPLACE_WITH_VERIFIED_AUTH_USER_UUID'::uuid,
  'REPLACE_WITH_OPERATOR_IDENTITY',
  'REPLACE_WITH_REASON_FOR_MODERATOR_ACCESS'
);
```

To revoke access, delete that user's membership as a database administrator:

```sql
delete from moderation_private.reviewers
where user_id='REPLACE_WITH_VERIFIED_AUTH_USER_UUID'::uuid;
```

Every request rechecks membership, Auth user status and the JWT's live Auth
session. Banned, deleted, anonymous, expired-session and missing-session users
are denied. Membership/session rows are locked during requests: if a decision
already holds the lock, it can finish before a concurrent revocation commits;
once revocation commits, subsequent requests fail, including retries.

No production migration, deployment, account grant, or ad decision is performed
by these repository changes. Production rollout requires its own review.

## Review workflow

- The queue lists **safety `held`** and **duplicate `review_identical` or
  `review_similar`** ads in pages of 25. Scanner `pending` errors and
  `duplicate_same_creator` are not human-review overrides.
- Select an ad. Inspect its creative, caption, scanner findings and matched
  creative. The page accepts only short-lived signed links on the configured
  project's Storage origin, bound to each ad's stored owner path. It does not
  fall back to public links. Failed or missing previews disable the decision
  form; **Refresh queue** retries loading them.
- Choose the **safety** or **duplicate** check, choose **clear** or **reject**,
  write a 10–2,000 character reason, and confirm the action.
- Clearing safety changes only `held` to `passed`; rejecting changes only
  `held` to `failed`. The scanner's terminal-state rules are unchanged.
- Duplicate decisions use the existing service-only resolution function,
  passing the moderator's authenticated UUID as reviewer identity. Existing
  match references, fingerprints and duplicate audit entries are preserved.
- Publication requires **both checks passed** and, for private uploads,
  verified image publication. Clearing one cannot override another hold,
  rejection, pending scan, removed ad, or publication failure.
- Findings and creative state are version-checked under the ad row lock. A
  competing decision or changed creative requires a fresh review. Monetary
  totals do not invalidate a review.

The decision UUID and exact arguments are saved in tab-scoped session storage
before submission. A lost response shows **Retry saved decision**; a reload of
that tab retains it. An identical authorized retry returns the original result.
The database's unique `(ad_id, review_kind)` constraint also prevents a second
resolution from another tab or after the tab is closed. Never delete database
audit rows or reset screening states to retry. If local state is unreadable,
an administrator should inspect `moderation_private.decisions` before removing
that tab's saved request.

History records the verified reviewer UUID, reason, request UUID, timestamp,
original creative/findings snapshot, and resulting states. These rows are
inaccessible for direct browser or service-role reads/writes. Trusted database
administrators can inspect them; they are not a tamper-proof log against a
Postgres administrator. Existing `moderation_events` and
`ad_duplicate_review_decisions` remain available to existing trusted services.

## Authorization design

`moderation_private` contains the allowlist, audit table, and fixed-search-path
security-definer implementations. Its tables have RLS enabled and no browser
policies or direct role grants. The public API functions are security invokers.
Authenticated users may call them, but every implementation validates
`auth.uid()` against the live allowlist and `auth.sessions`. User-supplied
reviewer names, `user_metadata`, and JWT role metadata never authorize access.
The service role cannot use the new page functions without an authenticated
moderator identity. Existing privileged scanner/operator functions are unchanged.

The preview function verifies the bearer token and calls `moderator_ad` with
that user's JWT. Only the current held ad and the match returned by that RPC
can be previewed; callers cannot supply paths, buckets, or a second ad ID. A
service client signs the exact owner-bound objects for **60 seconds**, using
private originals for modern ads and `ad-images` only for legacy public ads.
The function rechecks moderator authorization and the review version after
signing, discarding links if access was revoked or the review changed.

Preview responses are `Cache-Control: no-store`; signed URLs are not saved in
decision retry state or logs. Already-issued links can remain usable until
expiry, and already-downloaded images cannot be revoked. Signing previews does
not broaden Storage policies, make the private bucket public, or authorize a
moderation decision. Decisions still pass the independent database guard.

Audit insertion, screening update, existing duplicate audit and moderation event
are in one transaction. The request UUID lock serializes uncertain retries;
the ad row lock serializes competing decisions. Invalid requests and stale
views roll back without changing ad or accounting data.

## Verification and limits

Run `npm ci --ignore-scripts --no-audit --no-fund` then `npm test`.
The focused command is `node --test tests/moderation_*.test.mjs`.
The suites apply the real migrations to isolated
PGlite fixtures and check authorization, live revocation/session checks,
forged claims, closed table/RPC privileges, independent screening, rejection,
stale review, replay identity, audit retention, pagination and saved-request
recovery. Additional tests cover signed-link authorization and late revocation,
owner/path binding, missing images disabling decisions, and the combined
moderation/private-publication gate. They do not prove hosted Supabase session
behavior or true concurrent PostgreSQL connections.

After staging rollout, verify with one granted moderator and one ordinary
account: the ordinary account cannot call any `moderator_*` read/decision RPC;
the moderator can view a held synthetic creative, record each independent
check with an audit reason, and replay a saved request without another audit
entry. Revoke the moderator and confirm their existing session is denied.
Run Supabase security advisors after deployment. No hosted review has been
performed by the offline test suite.

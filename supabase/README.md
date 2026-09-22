# AdBattle wallet deployment

This branch replaces direct per-Support Stripe Checkout with an internal
wallet and batched creator settlements.

## Money behavior

- A supporter must add at least $10.00 through Stripe Checkout.
- The full top-up is credited to their AdBattle balance after the signed
  Stripe webhook confirms payment.
- They can then support any approved ad with any whole-cent amount from $0.01.
- Each Support accrues 90% to the creator and 10% to AdBattle.
- Stripe charges and transfer fees are paid by the platform, reducing
  AdBattle's 10%; they never reduce the creator's 90% ledger credit.
- Each ad settles at cumulative Support thresholds of $10, $25, $50, $100,
  then doubling, or after 24 hours without new Support when at least $10 is
  pending.

## Safe deployment order

Do not publish the updated root `index.html` until steps 1–5 are complete.

1. For a new installation, apply the migrations in this order:
   `20260920_wallet_ledger.sql`, `20260921_wallet_safety.sql`,
   `20260922_wallet_capability_recovery.sql`, then
   `20260923_wallet_balance_recovery.sql` from `migrations/` in the Supabase SQL
   editor. For an existing installation, apply only missing migrations in that
   order. The safety and recovery migrations are one-time and transactional;
   do not rerun them after success because they rename internal RPCs. Take a
   backup and inspect the actual existing schema before applying migrations.
2. Set the `SETTLEMENT_CRON_SECRET` Edge Function secret to a new random value.
   Existing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` secrets remain in use.
3. Deploy these functions:
   - `create-wallet-checkout`
   - `support-from-wallet`
   - `stripe-webhook`
   - `settle-wallet-support`
4. Keep the Stripe webhook endpoint pointed at
   `/functions/v1/stripe-webhook` and subscribed to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.updated`
   - `charge.dispute.closed`
   - `charge.dispute.funds_withdrawn`
   - `charge.dispute.funds_reinstated`

   The replacement webhook continues to finish any direct-Support Checkout
   sessions created before the wallet rollout.
5. Schedule the settlement worker, using the same secret from step 2:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

select vault.create_secret(
  'https://bmsrdzqprxvldltaislp.supabase.co',
  'adbattle_project_url'
);

select vault.create_secret(
  'REPLACE_WITH_THE_SETTLEMENT_CRON_SECRET',
  'adbattle_settlement_cron_secret'
);

select cron.schedule(
  'adbattle-wallet-settlement',
  '* * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'adbattle_project_url'
    ) || '/functions/v1/settle-wallet-support',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-adbattle-settlement-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'adbattle_settlement_cron_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
```

6. Test in Stripe test mode:
   - $10 top-up credits exactly $10 to the wallet once.
   - A duplicate webhook does not credit twice.
   - $0.01 Support debits exactly one cent.
   - Gross ad Support increases immediately.
   - The creator ledger receives $0.009 and AdBattle receives $0.001.
   - Crossing $10 creates one $9 creator transfer.
   - Re-running the worker cannot duplicate that transfer.

### Staging top-up and one-cent Support runner

Run `scripts/adbattle_topup_test.py` from a private local terminal against
**adbattle-test only**. It uses Python 3's standard library, a project
publishable (or legacy `anon`) key, and an ordinary test-user login. Never give
it a secret/service-role key, Stripe key, database password, production user,
or real card. Do not use this runner as a reason to rerun hosted migrations or
deploy any code.

First, use a fresh test user with no wallet top-up history to create or recheck
one $10 Stripe **test-mode** top-up:

```sh
python3 scripts/adbattle_topup_test.py
```

The runner saves the checkout request UUID and private Checkout URL before it
can initiate or resume payment. Its state is stored per user under
`~/.local/state/adbattle-wallet-test/nccqnrcdygujulrnwair/`, with the directory
restricted to mode `0700` and its state/lock files private. Passwords and access
tokens remain in memory. Keep this state: after a timeout, interruption, or
lost response, rerun the same command rather than deleting state, generating a
new request ID, or paying again. Treat the saved Checkout URL as a credential;
do not paste the state file or URL into issues, chat, or logs.

After the top-up is credited, use the same computer, test user, and saved state
to exercise one-cent Support idempotency:

```sh
python3 scripts/adbattle_topup_test.py --support
```

`--support` never creates another Checkout. It creates a synthetic staging ad,
prints a narrowly scoped approval statement if administrator moderation is
needed, saves the Support request UUID before sending, and submits the exact
same one-cent request twice. Do not change or discard that UUID after an
uncertain response. The check requires one debit and one Support record, a
$9.99 balance, $10.00 lifetime top-ups, $0.01 lifetime Support, and the exact
$0.009 creator / $0.001 AdBattle accrual.

#### Manual duplicate-webhook verification

The local runner cannot authenticate or replay Stripe webhooks. After the
Support check, an operator should open the **test-mode** Stripe Dashboard,
locate the original paid Checkout's successful
`checkout.session.completed` delivery to the adbattle-test
`/functions/v1/stripe-webhook` endpoint, and use Stripe's **Resend** action for
that same event. Verify the replay returns HTTP 200. Then rerun the plain
command above with the preserved state and confirm it still reports exactly
one top-up and one matching $10 ledger credit, with final balance $9.99,
lifetime top-ups $10.00, and lifetime Support $0.01. Do not create a new event,
Checkout, request UUID, or payment for this replay check.

The following staging results have been completed and reported for
adbattle-test:

- One $10 Stripe test payment produced exactly one top-up and ledger credit.
- Sending $0.01 Support twice with the same request ID produced one debit and
  one Support record.
- Creator accrual was $0.009 and AdBattle accrual was $0.001.
- Resending the original paid Checkout webhook returned HTTP 200 and retained
  exactly one credit.
- Final balance was $9.99; lifetime top-ups were $10.00; lifetime Support was
  $0.01.

These results do **not** complete staging. The AdBattle browser frontend,
creator settlements and retry behavior, refunds/disputes and reconciliation,
and multi-connection concurrency checks remain outstanding. Keep all existing
test-mode, deployment-order, credential-handling, reconciliation-hold, and
production-launch restrictions in force.

### Local frontend against adbattle-test

The tracked production configuration is unchanged. Localhost is fail-closed:
opening `index.html` directly, using `python3 -m http.server`, using
`127.0.0.1`, or omitting/mistyping any staging value stops initialization
before a Supabase client is created. Use the staging server, which validates
the key against the fixed adbattle-test Auth endpoint, holds it in memory, and
serves an uncacheable runtime configuration without writing it into the
checkout or repository:

```sh
export ADBATTLE_SUPABASE_PROJECT_REF='nccqnrcdygujulrnwair'
export ADBATTLE_SUPABASE_URL='https://nccqnrcdygujulrnwair.supabase.co'
export ADBATTLE_FRONTEND_ORIGIN='http://localhost:8000'
read -rsp 'adbattle-test publishable key: ' ADBATTLE_SUPABASE_PUBLISHABLE_KEY
export ADBATTLE_SUPABASE_PUBLISHABLE_KEY
printf '\n'
python3 scripts/serve_staging.py
```

Open exactly <http://localhost:8000>. The page must show the fixed
`ADBATTLE TEST · LOCAL STAGING` badge. Supply only adbattle-test's publishable
key (or legacy `anon` key); never use a secret/service-role key. The tracked
`adbattle.local-config.js` is deliberately empty, and the local server replaces
its response in memory. Do not save the key in that file, shell history, a URL,
or a committed environment file.

The limited staging schema intentionally disables likes, ad posting/image
storage, and creator onboarding. Their controls are visibly disabled and no
requests are made to the missing `likes` table, `ad-images` bucket,
`sync-connect-status`, or `create-connect-account`. Login, approved ad loading,
wallet balances, pending creator balance, top-ups, and wallet Support remain
available under the existing RLS policies. This is a UI capability switch, not
a database-permission bypass.

Browser Support and top-up retry records are keyed by Supabase project and user.
Both UUIDs are written to `localStorage` before their Edge Function request.
After an uncertain response, reload and retry the same ad/amount or top-up
amount; do not clear storage. A different amount is blocked while unresolved.
The original top-up attempt time is also stored. Automatic retry stops after 20
hours, conservatively before [Stripe may prune an idempotency key after 24
hours](https://docs.stripe.com/api/idempotent_requests).
Unknown-age or stale state is retained for reconciliation and its UUID is never
automatically replaced. A `?wallet=cancel` URL alone is not proof that payment
failed: top-up state is removed only after its exact session and amount are
visible for the signed-in user in `wallet_topups`, with a recorded status of
`paid`, `partially_refunded`, `refunded`, or `disputed`. These rows are created
atomically with the original ledger credit; a later refund or dispute does not
make the original Checkout unconfirmed. Unknown statuses, missing/mismatched
rows, query errors, and changed pending requests preserve the retry record.
Cancellation or expiration requires authoritative Stripe-side verification.
Existing unscoped Support retry state is moved to the project-scoped key rather
than discarded.

Checkout return messages use this recorded-payment evidence, never the return
URL alone. A confirmed top-up stops showing a verification message even when
the wallet is frozen. The balance and return notice explicitly report the
payment-review hold and unavailable Support. This only clears the browser's
completed Checkout retry record: refund/dispute holds, balances, and ledger
entries remain unchanged. Reloading after the retry record has been cleared
shows a neutral return message and the current balance/hold; receipt evidence
is only cached in memory for the current page and user.

#### Staging Edge Function configuration and redeployment

Set these Edge Function secrets/configuration values on **adbattle-test only**:

```text
ADBATTLE_STAGING_ORIGIN=http://localhost:8000
ADBATTLE_CHECKOUT_ORIGIN=http://localhost:8000
```

The functions accept only that exact local origin in addition to the fixed
production allowlist. `*`, alternate ports/hosts, paths, query strings, and
client-supplied redirect destinations are rejected. Checkout return URLs come
only from server configuration. When staging CORS is enabled, omitting
`ADBATTLE_CHECKOUT_ORIGIN` is an error rather than a fallback to production.
The existing `sk_test_` checks remain in force—do not configure a live Stripe
key.

After reviewing the diff, redeploy these functions to adbattle-test:

- `create-wallet-checkout` — CORS plus configured success/cancel destination.
- `support-from-wallet` — CORS validation.
- `create-checkout-session` — CORS validation on the retired fail-closed route.

Do not redeploy `stripe-webhook` or `settle-wallet-support` for this frontend
change. Do not rerun either hosted SQL migration.

For a CLI deployment, authenticate the Supabase CLI separately, verify the
project ref in every command, set the two values above, and deploy only the
three named functions. For Dashboard packaging, create a clean temporary
bundle—never include `.env`, local state, keys, or the repository history—with
this relative layout so each `../_shared/http.ts` import remains intact:

```text
adbattle-staging-functions/
├── _shared/http.ts
├── create-wallet-checkout/index.ts
├── support-from-wallet/index.ts
└── create-checkout-session/index.ts
```

Copy those four tracked files into that layout, archive the **contents** of
`adbattle-staging-functions/` (not a parent directory and not the whole repo),
and inspect the archive before using the adbattle-test Dashboard's Edge
Functions upload/deploy flow. Confirm the Dashboard project ref is
`nccqnrcdygujulrnwair`, configure the two values in Edge Function Secrets, and
retain each function's JWT setting from `supabase/config.toml`. If the Dashboard
editor requires one function at a time, include that function directory and
the same `_shared/http.ts` sibling in each package. Do not paste secrets into
source files.

If testing account creation with email confirmation, add
`http://localhost:8000/**` to adbattle-test's Auth redirect allowlist; do not
replace production Site URL or production redirect entries.
7. Deploy `create-checkout-session`, the fail-closed replacement for the
   retired direct-Support endpoint, and then immediately publish the updated
   root `index.html`. The retired endpoint can no longer create 1/9/90
   payments, while its already-created sessions can still finish through the
   transitional webhook.

## Before live payments

The new top-up and settlement functions deliberately reject non-test Stripe
keys. This is a test-mode implementation, not a production launch approval.
Do not remove this guard until the remaining operational checks below pass.

## Safety behavior and review holds

- Support request IDs are saved in browser storage before submission and reused
  after a lost response or reload. An unresolved request blocks a different ad
  or amount until it is reconciled. Do not clear browser storage to retry an
  uncertain payment; check its request ID in the ledger first. Clearing storage
  or switching devices loses this browser-side identity.
- Transfer destinations are snapshotted. The worker rechecks authorization
  immediately before each Stripe POST. Automatic retries stop 20 hours after
  the first authorized attempt, before Stripe's documented >=24h key expiry.
  Held transfers keep their original settlement ID and reserved balance.
- Refunds subtract only the increase in cumulative refunded cents; duplicates
  and older snapshots do not subtract again. Already-spent refunds can make a
  wallet negative. Refund/dispute events received before payment credit are
  retained and applied during crediting.
- Every wallet refund/dispute freezes the affected wallet and globally pauses
  automated settlements pending review. Disputes are held, not automatically
  debited/restored: overlap with refunds and already-transferred funds needs
  operator reconciliation. Won/closed events never automatically unfreeze.
- A webhook cannot recall a transfer already in flight. Already-sent money,
  transfer reversals, lost/won disputes, fee reconciliation, and reserve funding
  still require an operational process before production.

### Reconciliation procedure (operator only)

Inspect `wallet_payment_risks`, `wallet_payment_risk_events`,
`wallet_transfer_guards`, `support_settlements`, and the corresponding Stripe
objects. For an ambiguous transfer, verify its metadata settlement ID, amount,
currency, and destination in Stripe. If it exists, call
`complete_wallet_settlement` with that verified transfer ID; do not create a
replacement transfer. If absent or uncertain, keep the hold and investigate.
Never reset `first_attempt_at` or mint another settlement ID to bypass a hold.

For payment-risk holds, reconcile the actual refund/dispute outcome, any
creator transfers, fees, and wallet debt before an operator clears the risk.
There is intentionally no automatic hold-release endpoint. Database operators
must document corrective ledger entries and verify balances before marking a
risk resolved or unfreezing a wallet. A top-up alone never unfreezes a wallet.

## Recover a cached capability rejection (test mode only)

Stripe can cache an HTTP 400 response under an idempotency key after endpoint
execution begins. Enabling the destination's Transfers capability does not
change that cached response. Workbench explicitly labels replayed requests;
Stripe also returns `Idempotent-Replayed: true`. See
[Stripe's error handling guidance](https://docs.stripe.com/error-low-level#idempotency).
This recovery is for the exact code `insufficient_capabilities_for_transfer`.
It is not a general retry-key reset.

After reviewing and merging this change into the wallet branch, deploy to
**adbattle-test only**:

1. Apply the new, one-time transactional migration
   `migrations/20260922_wallet_capability_recovery.sql` after the two existing
   migrations. Do not rerun those existing migrations. The new migration alone
   authorizes no recovery and changes no wallet or settlement balances.
2. Redeploy only `settle-wallet-support` from the same reviewed commit. It remains
   a single `index.ts` file with JWT verification OFF and the existing private
   `SETTLEMENT_CRON_SECRET` header required. Preserve the test Stripe key.
3. Confirm the exact guard destination's **Transfers** capability is Active in
   the same Stripe sandbox and inspect the original failed transfer request.
   The creator's current linked account must match that frozen destination;
   the worker refuses mismatches before contacting Stripe, and the database
   independently rechecks the match before authorizing recovery. Do not change
   either account to work around this check. Check settlement
   status is `retry`, its original 20-hour window is still open, and there are
   no payment-risk/manual-review holds. Pause any schedule during recovery.
4. In the function tester, send POST with the existing
   `x-adbattle-settlement-secret` header and this body, replacing the placeholder
   with that existing settlement UUID:

   ```json
   {"recover_capability_failure":"SETTLEMENT_UUID"}
   ```

   The worker rechecks the guard, then POSTs the original immutable parameters
   with the original idempotency key to Stripe. It authorizes a replacement
   only for HTTP 400, the exact capability error code, an explicit replay
   header, and a valid Stripe request ID. It trusts the actual Stripe response,
   not an error string or evidence supplied in the request body.

   - `recovery_authorized`: one replacement key has been committed to the guard.
     This request has not sent that replacement key to Stripe.
   - `recovery_already_authorized`: keep the already committed key. This is also
     the response after an authorization succeeded but its reply was lost.
   - `succeeded`: the original-key request returned a transfer; its completion
     was recorded instead of authorizing a second key.
   - `held` or an error: inspect state and Stripe logs. Do not change the ID,
     original first-attempt time, or hold flags to force a retry.
5. After `recovery_authorized` or `recovery_already_authorized`, run the normal
   worker with `{}` once `next_attempt_at` is due. It reads the persisted key.
   The original destination, amount, settlement ID, retry schedule and 20-hour
   deadline remain unchanged. Lost Stripe responses or ledger failures reuse
   that same replacement key. This capability action never authorizes another
   replacement.
6. Verify the returned transfer in Stripe by settlement metadata, amount,
   currency, and destination; inspect the completed settlement and balances.
   Run the normal worker again and verify no duplicate transfer is created.

If the replacement itself becomes a cached rejection, stop for reconciliation.
Only a verified `balance_insufficient` rejection can use the separate, bounded
balance recovery below; the capability action cannot authorize it. The
existing webhook-versus-transfer race limitation still applies. Never use this
recovery for a 5xx, timeout, unknown outcome, expired window, or risk hold.
Do not roll back to an old worker that ignores recovery keys while a recovered
settlement is pending. The guard keeps the verification request ID and timestamp
for audit. Database constraints require the key and evidence together, restrict
the key to its settlement-specific format, and prevent reuse of a Stripe request
ID across recovery records. Browser roles cannot read or mutate the guard or
invoke recovery RPCs.

## Recover a cached balance rejection after capability recovery (test mode only)

Funding the platform does not change an insufficient-funds response already
cached under its capability-recovery key. This action supports exactly that
case: an existing active `retry` settlement whose key ends in
`-capability-recovery-1`. It permits one additional persisted key ending in
`-balance-recovery-1`. It cannot replace an original key, replace its own key,
clear a hold, or extend the original 20-hour window.

After this change is reviewed and merged, use **adbattle-test only**:

1. With the preceding three wallet migrations already applied, apply only
   `migrations/20260923_wallet_balance_recovery.sql` once. It authorizes no
   recovery and changes no wallet or settlement balances. Redeploy only
   `settle-wallet-support/index.ts` from the same reviewed commit, with JWT
   verification OFF and the existing test Stripe key and private settlement
   secret. Do not rerun earlier migrations or redeploy other functions.
2. Pause scheduled settlement runs and other platform fund movements while
   recovering. Confirm the frozen destination still matches the creator's
   current linked account, the original deadline is open, and no manual-review
   or payment-risk hold exists. Confirm the **platform's available USD card
   balance** covers the creator transfer; pending funds and the destination
   account's funds do not qualify. See [Stripe balance retrieval](https://docs.stripe.com/api/balance/balance_retrieve)
   and [transfer funding](https://docs.stripe.com/api/transfers/create).
3. In the function tester, send POST with the existing
   `x-adbattle-settlement-secret` header and exactly this body:

   ```json
   {"recover_balance_failure":"SETTLEMENT_UUID"}
   ```

   The worker reads the platform balance with the same credentials used for
   transfers. Immediately after this balance GET, it reloads the database
   transfer guard before the verification POST. A newly recorded hold, expired
   deadline, changed guard destination, unavailable authorization or unexpected
   key stops the POST. If another recovery has already committed the
   balance-recovery key, it returns `balance_recovery_already_authorized`
   without another Stripe request. Otherwise it repeats the immutable transfer
   request using the exact existing capability-recovery key.
   A successful transfer is reconciled on the same
   settlement. A replacement is authorized only for HTTP 400 with
   `Idempotent-Replayed: true`, error type `invalid_request_error`, exact code
   `balance_insufficient`, no transfer ID, and a valid Stripe request ID.
   A second balance GET must still show sufficient available USD card funds.
   Both balance responses must be test-mode responses with valid request IDs.
   Request bodies cannot supply their own evidence, amount, account, or key.

   - `balance_recovery_authorized`: the new key and evidence were committed
     together. This invocation has not sent the new key to Stripe.
   - `balance_recovery_already_authorized`: the existing committed key remains
     selected, including when an earlier authorization reply was lost.
   - `succeeded`: the preceding key returned a matching transfer, and the worker
     recorded its completion without authorizing another key.
   - `held` or an error: inspect the settlement and Stripe logs. Preserve all
     keys, evidence, original timestamps and holds. A 5xx, timeout, malformed
     response, unverified rejection, changed destination or expired deadline
     does not authorize replacement.
4. After authorization, send the normal worker `{}` once `next_attempt_at` is
   due. It loads the committed balance-recovery key and retains the same
   settlement, amount, frozen destination, metadata and deadline. A lost Stripe
   reply or failed ledger completion reuses that key. Normal retries deliberately
   do not require a balance GET: replaying an already successful transfer must
   still reconcile it after its funds have left the platform.
5. Verify one transfer in Stripe with the matching settlement metadata,
   destination, USD amount and transfer ID recorded in the same completed
   settlement. For a $10 Support settlement at 90/10, the creator transfer is
   **900 cents ($9.00)**. Verify the corresponding ledger and pending accruals,
   then run the normal worker again and confirm no duplicate transfer.

The balance check is a snapshot, not a reservation. Funds may move between
authorization and the new-key POST. If that key also receives a cached error,
stop for reconciliation; this implementation provides no further replacement.
Do not change the settlement ID or first-attempt time to escape the deadline.
Do not roll back to a worker or database wrapper that ignores the committed
balance-recovery key while the settlement is pending. The existing
webhook-versus-transfer race limitation still applies: a hold committed after
the final database authorization cannot recall a Stripe request already sent.

The database independently checks the preceding key, active retry status,
frozen/current destination match, creator readiness, payment risks, original
deadline and recorded balance amount. The replacement key, rejected-request
ID, fresh balance-request ID, available amount and timestamp are stored
atomically. Request IDs are format-checked and unique within their respective
audit columns. The predecessor audit remains intact. Browser roles cannot
invoke recovery, and the service role cannot bypass the new preparation
wrapper by calling its renamed predecessor directly.

## Automated checks

With Node 24+: `npm ci --ignore-scripts` followed by `npm test`.
Tests exercise the actual browser helper, Edge Function logic with mocked
Stripe, and the SQL migrations/RPCs/RLS in PGlite (PostgreSQL WASM).
The fixture models the known legacy schema; it does not prove compatibility
with the current deployed database. Hosted Supabase authentication, cron,
and real Stripe test-mode delivery/transfer require separate staging checks.

### Concurrent PostgreSQL connections

With Python 3 and PostgreSQL server/client binaries installed, run as an
ordinary user (not root):

```sh
npm run test:concurrency
# If PostgreSQL binaries are not discovered through pg_config or PATH:
python3 scripts/test_wallet_concurrency.py --postgres-bin /usr/lib/postgresql/16/bin
```

On Arch Linux the binaries normally live in `/usr/bin`. The runner initializes
its own disposable cluster under a private temporary directory, listens only
on a Unix socket, ignores inherited PostgreSQL connection settings, and accepts
no database URL or credentials. It stops the server and removes the cluster
on completion. It never contacts Supabase or Stripe.

The minimal legacy fixture and all four wallet migrations are applied without
rewriting the SQL. RPC calls run as `service_role` on independent connections.
A separate transaction holds the relevant wallet or ad lock; the test checks
`pg_stat_activity` and `pg_blocking_pids` to prove the requests overlap before
releasing that lock. A missing overlap or timeout fails the test.

Seven scenarios cover duplicate one-cent requests; conflicting amounts or ads
under the same request UUID; competing requests that exceed the balance;
distinct affordable requests; two wallets supporting the same ad; and a
waiting Support request encountering a newly committed refund hold. Assertions
check RPC outcomes, exact debit/Support counts and identities, running ledger
balances, wallet totals, ad totals, and the 90/10 microdollar accruals.

The `Wallet PostgreSQL concurrency` GitHub Actions job runs this suite for
relevant pull requests targeting `wallet-ledger-90-10`. These tests cover local
PostgreSQL transaction behavior; hosted Auth/RLS integration, HTTP retries,
settlement/Stripe races, and production-schema compatibility are separate checks.

## Production prerequisites

The wallet creates stored-value, refund, dispute, tax, and money-transmission
questions that are not solved by application code. Keep this in Stripe test
mode until Stripe approves the flow and qualified legal/accounting review is
complete. A production launch also needs full dispute/transfer-reversal
reconciliation, fee accounting, monitoring/alerts for review holds, and an
operations process for failed settlements.

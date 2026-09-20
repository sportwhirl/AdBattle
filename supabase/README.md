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

1. Apply `migrations/20260920_wallet_ledger.sql`, then
   `migrations/20260921_wallet_safety.sql` in the Supabase SQL editor.
   The safety migration is one-time and transactional. Do not rerun it after
   success; it renames internal RPCs. Take a backup and inspect the actual
   existing schema before applying either migration.
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

## Automated checks

With Node 24+: `npm ci --ignore-scripts` followed by `npm test`.
Tests exercise the actual browser helper, Edge Function logic with mocked
Stripe, and both SQL migrations/RPCs/RLS in PGlite (PostgreSQL WASM).
The fixture models the known legacy schema; it does not prove compatibility
with the current deployed database. Multi-connection concurrency, hosted
Supabase authentication, cron, and real Stripe test-mode delivery/transfer
must still be tested in a staging environment.

## Production prerequisites

The wallet creates stored-value, refund, dispute, tax, and money-transmission
questions that are not solved by application code. Keep this in Stripe test
mode until Stripe approves the flow and qualified legal/accounting review is
complete. A production launch also needs full dispute/transfer-reversal
reconciliation, fee accounting, monitoring/alerts for review holds, and an
operations process for failed settlements.

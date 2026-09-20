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

1. Apply `migrations/20260920_wallet_ledger.sql` in the Supabase SQL editor.
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

The wallet creates stored-value, refund, dispute, tax, and money-transmission
questions that are not solved by application code. Keep this in Stripe test
mode until Stripe approves the flow and qualified legal/accounting review is
complete. A production launch also needs refund/dispute ledger reversals,
reconciliation, monitoring, and an operations process for failed settlements.

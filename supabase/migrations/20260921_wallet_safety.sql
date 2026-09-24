-- Apply after 20260920_wallet_ledger.sql. Safety holds deliberately require
-- operator reconciliation; they are never cleared by a later top-up/event.
begin;

create table public.wallet_payment_risks (
  payment_intent_id text primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  dispute_seen boolean not null default false,
  last_event_id text not null,
  last_event_type text not null,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.wallet_payment_risk_events (
  event_id text primary key,
  payment_intent_id text not null references public.wallet_payment_risks(payment_intent_id),
  event_type text not null,
  received_at timestamptz not null default now()
);
create table public.wallet_transfer_guards (
  settlement_id uuid primary key references public.support_settlements(id),
  destination text not null,
  first_attempt_at timestamptz,
  manual_review boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.wallet_payment_risks enable row level security;
alter table public.wallet_payment_risk_events enable row level security;
alter table public.wallet_transfer_guards enable row level security;
revoke all on public.wallet_payment_risks, public.wallet_payment_risk_events,
  public.wallet_transfer_guards from public, anon, authenticated;
grant all on public.wallet_payment_risks, public.wallet_payment_risk_events,
  public.wallet_transfer_guards to service_role;

create function public.record_wallet_payment_risk(
  p_payment_intent_id text, p_user_id uuid, p_refunded_cents bigint,
  p_dispute_seen boolean, p_event_id text, p_event_type text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  risk public.wallet_payment_risks%rowtype;
  topup public.wallet_topups%rowtype;
  delta bigint;
  balance bigint;
begin
  if p_refunded_cents is null or p_refunded_cents < 0
     or nullif(p_payment_intent_id, '') is null then
    raise exception 'INVALID_PAYMENT_RISK';
  end if;

  -- All risk processing serializes on the wallet, just like Support spending.
  -- Create the frozen wallet even if this event precedes the paid webhook.
  insert into public.wallets(user_id, status) values (p_user_id, 'frozen')
    on conflict (user_id) do nothing;
  perform 1 from public.wallets where user_id = p_user_id for update;

  insert into public.wallet_payment_risks as r (
    payment_intent_id, user_id, refunded_cents, dispute_seen, last_event_id, last_event_type
  ) values (
    p_payment_intent_id, p_user_id, p_refunded_cents, p_dispute_seen, p_event_id, p_event_type
  ) on conflict (payment_intent_id) do update set
    refunded_cents = greatest(r.refunded_cents, excluded.refunded_cents),
    dispute_seen = r.dispute_seen or excluded.dispute_seen,
    resolved_at = case when excluded.refunded_cents > r.refunded_cents
      or (excluded.dispute_seen and not r.dispute_seen) then null else r.resolved_at end,
    last_event_id = excluded.last_event_id, last_event_type = excluded.last_event_type,
    updated_at = now()
  returning * into risk;
  if risk.user_id <> p_user_id then raise exception 'PAYMENT_RISK_USER_MISMATCH'; end if;

  insert into public.wallet_payment_risk_events(event_id, payment_intent_id, event_type)
    values (p_event_id, p_payment_intent_id, p_event_type) on conflict do nothing;

  select * into topup from public.wallet_topups
    where stripe_payment_intent_id = p_payment_intent_id for update;
  if found then
    if topup.user_id <> p_user_id or risk.refunded_cents > topup.amount_cents then
      raise exception 'PAYMENT_RISK_AMOUNT_MISMATCH';
    end if;
    delta := risk.refunded_cents - topup.reversed_cents;
    if delta > 0 then
      update public.wallets set available_cents = available_cents - delta,
        updated_at = now() where user_id = p_user_id returning available_cents into balance;
      insert into public.wallet_transactions (
        user_id, entry_type, amount_cents, balance_after_cents, topup_id, metadata
      ) values (p_user_id, 'refund', -delta, balance, topup.id,
        jsonb_build_object('stripe_event_id', p_event_id,
          'cumulative_refunded_cents', risk.refunded_cents));
    end if;
    update public.wallet_topups set reversed_cents = risk.refunded_cents,
      status = case when risk.dispute_seen then 'disputed'
        when risk.refunded_cents = amount_cents then 'refunded'
        when risk.refunded_cents > 0 then 'partially_refunded' else status end,
      updated_at = now() where id = topup.id;
  end if;
  if risk.resolved_at is null then
    update public.wallets set status = 'frozen', updated_at = now() where user_id = p_user_id;
  end if;
end;
$$;

-- Risk events can arrive before the paid webhook. Credit and apply any
-- earlier refund in the SAME transaction so that money is never spendable.
alter function public.record_wallet_topup(text,text,uuid,bigint)
  rename to record_wallet_topup_unchecked;
create function public.record_wallet_topup(
  p_stripe_session_id text, p_stripe_payment_intent_id text,
  p_user_id uuid, p_amount_cents bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; risk public.wallet_payment_risks%rowtype; balance bigint;
begin
  -- Lock order matches risk/spend routines: wallet before top-up.
  insert into public.wallets(user_id) values (p_user_id) on conflict do nothing;
  perform 1 from public.wallets where user_id = p_user_id for update;
  result := public.record_wallet_topup_unchecked(
    p_stripe_session_id, p_stripe_payment_intent_id, p_user_id, p_amount_cents);
  select * into risk from public.wallet_payment_risks
    where payment_intent_id = p_stripe_payment_intent_id;
  if found then
    perform public.record_wallet_payment_risk(risk.payment_intent_id, p_user_id,
      risk.refunded_cents, risk.dispute_seen, risk.last_event_id, risk.last_event_type);
  end if;
  select available_cents into balance from public.wallets where user_id = p_user_id;
  return result || jsonb_build_object('balance_cents', balance);
end;
$$;

-- Claims take an immutable destination snapshot, and stop while any wallet
-- refund/dispute remains unreconciled. This conservative pause is global.
alter function public.claim_due_wallet_settlements(integer)
  rename to claim_due_wallet_settlements_unchecked;
create function public.claim_due_wallet_settlements(p_limit integer default 25)
returns table (settlement_id uuid, ad_id bigint, creator_user_id uuid,
  stripe_account_id text, creator_transfer_cents bigint, creator_micros bigint,
  platform_micros bigint, trigger_reason text)
language plpgsql security definer set search_path = '' as $$
declare item record;
begin
  if exists (select 1 from public.wallet_payment_risks where resolved_at is null) then return; end if;
  for item in select * from public.claim_due_wallet_settlements_unchecked(p_limit) loop
    insert into public.wallet_transfer_guards(settlement_id, destination, manual_review, reason)
      select item.settlement_id, item.stripe_account_id, s.attempts > 1,
        case when s.attempts > 1 then 'Unknown pre-guard transfer history' end
      from public.support_settlements s where s.id = item.settlement_id
      on conflict do nothing;
    if exists (select 1 from public.wallet_transfer_guards g
      where g.settlement_id = item.settlement_id and g.manual_review) then
      update public.support_settlements set status = 'retry', next_attempt_at = 'infinity',
        last_error = 'Manual reconciliation required' where id = item.settlement_id;
      continue;
    end if;
    settlement_id := item.settlement_id; ad_id := item.ad_id;
    creator_user_id := item.creator_user_id; stripe_account_id := item.stripe_account_id;
    creator_transfer_cents := item.creator_transfer_cents;
    creator_micros := item.creator_micros; platform_micros := item.platform_micros;
    trigger_reason := item.trigger_reason;
    return next;
  end loop;
end;
$$;

-- Called immediately before EVERY Stripe transfer POST. A guard that ages
-- past 20 hours is permanently held, well before Stripe's >=24h key expiry.
create function public.prepare_wallet_transfer(p_settlement_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare guard public.wallet_transfer_guards%rowtype; settlement public.support_settlements%rowtype;
begin
  select * into settlement from public.support_settlements where id = p_settlement_id for update;
  if not found then raise exception 'SETTLEMENT_NOT_FOUND'; end if;
  select * into guard from public.wallet_transfer_guards where settlement_id = p_settlement_id for update;
  if not found then raise exception 'TRANSFER_GUARD_NOT_FOUND'; end if;
  if settlement.status = 'succeeded' then
    return jsonb_build_object('allowed', false, 'reason', 'already_succeeded');
  end if;
  if exists (select 1 from public.wallet_payment_risks where resolved_at is null) then
    return jsonb_build_object('allowed', false, 'reason', 'payment_risk_hold');
  end if;
  if guard.manual_review or guard.first_attempt_at <= now() - interval '20 hours' then
    update public.wallet_transfer_guards set manual_review = true,
      reason = coalesce(reason, 'Retry window expired; reconcile Stripe before proceeding')
      where settlement_id = p_settlement_id;
    update public.support_settlements set status = 'retry', next_attempt_at = 'infinity',
      last_error = 'Retry window expired; manual reconciliation required'
      where id = p_settlement_id;
    return jsonb_build_object('allowed', false, 'reason', 'manual_review');
  end if;
  update public.wallet_transfer_guards set first_attempt_at = coalesce(first_attempt_at, now())
    where settlement_id = p_settlement_id returning * into guard;
  return jsonb_build_object('allowed', true, 'destination', guard.destination,
    'retry_before', guard.first_attempt_at + interval '20 hours');
end;
$$;

revoke all on function public.record_wallet_topup_unchecked(text,text,uuid,bigint),
  public.claim_due_wallet_settlements_unchecked(integer) from public, anon, authenticated, service_role;
revoke all on function public.record_wallet_payment_risk(text,uuid,bigint,boolean,text,text),
  public.record_wallet_topup(text,text,uuid,bigint), public.claim_due_wallet_settlements(integer),
  public.prepare_wallet_transfer(uuid) from public, anon, authenticated;
grant execute on function public.record_wallet_payment_risk(text,uuid,bigint,boolean,text,text),
  public.record_wallet_topup(text,text,uuid,bigint), public.claim_due_wallet_settlements(integer),
  public.prepare_wallet_transfer(uuid) to service_role;
commit;

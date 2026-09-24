-- Apply once AFTER 20260922_wallet_capability_recovery.sql. This migration
-- authorizes no payment and does not reset any existing key or retry deadline.
begin;

alter table public.wallet_transfer_guards
  add column balance_recovery_key text unique,
  add column balance_recovery_request_id text unique,
  add column balance_recovery_balance_request_id text unique,
  add column balance_recovery_available_cents bigint,
  add column balance_recovered_at timestamptz,
  add constraint wallet_balance_recovery_complete check (
    (balance_recovery_key is null and balance_recovery_request_id is null
      and balance_recovery_balance_request_id is null
      and balance_recovery_available_cents is null and balance_recovered_at is null)
    or
    (balance_recovery_key is not null and balance_recovery_request_id is not null
      and balance_recovery_balance_request_id is not null
      and balance_recovery_available_cents is not null and balance_recovered_at is not null
      and capability_recovery_key is not null
      and balance_recovery_available_cents > 0
      and balance_recovery_key = 'adbattle-settlement-' || settlement_id::text || '-balance-recovery-1'
      and balance_recovery_request_id ~ '^req_[A-Za-z0-9]+$'
      and balance_recovery_balance_request_id ~ '^req_[A-Za-z0-9]+$'
      and balance_recovery_request_id <> balance_recovery_balance_request_id)
  );

alter function public.prepare_wallet_transfer(uuid)
  rename to prepare_wallet_transfer_before_balance_recovery;

create function public.prepare_wallet_transfer(p_settlement_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; recovery_key text;
begin
  -- Preserve the predecessor's settlement->guard lock order and all holds.
  result := public.prepare_wallet_transfer_before_balance_recovery(p_settlement_id);
  if (result->'allowed') is distinct from 'true'::jsonb then
    return (case when jsonb_typeof(result) = 'object' then result else '{}'::jsonb end)
      || jsonb_build_object('allowed', false);
  end if;
  select balance_recovery_key into recovery_key
    from public.wallet_transfer_guards where settlement_id = p_settlement_id;
  return result || jsonb_build_object('balance_recovery_supported', true,
    'idempotency_key', coalesce(recovery_key, result->>'idempotency_key'));
end;
$$;

-- Service-only worker evidence: cached HTTP 400 balance_insufficient from the
-- capability-recovery key, then a fresh test-mode Stripe USD/card balance GET.
-- This does NOT support the original key or another balance-recovery key.
create function public.authorize_wallet_balance_recovery(
  p_settlement_id uuid, p_failed_key text, p_stripe_request_id text,
  p_error_code text, p_available_cents bigint, p_balance_request_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare settlement public.support_settlements%rowtype;
  guard public.wallet_transfer_guards%rowtype; recovery_key text;
begin
  if p_error_code is distinct from 'balance_insufficient'
    or p_failed_key is distinct from
      'adbattle-settlement-' || p_settlement_id::text || '-capability-recovery-1'
    or p_stripe_request_id is null or p_stripe_request_id !~ '^req_[A-Za-z0-9]+$'
    or p_balance_request_id is null or p_balance_request_id !~ '^req_[A-Za-z0-9]+$'
    or p_balance_request_id = p_stripe_request_id
  then raise exception 'INVALID_BALANCE_REJECTION_EVIDENCE'; end if;
  select * into settlement from public.support_settlements
    where id = p_settlement_id for update;
  if not found then raise exception 'SETTLEMENT_NOT_FOUND'; end if;
  select * into guard from public.wallet_transfer_guards
    where settlement_id = p_settlement_id for update;
  if not found then raise exception 'TRANSFER_GUARD_NOT_FOUND'; end if;
  if guard.capability_recovery_key is distinct from p_failed_key
  then raise exception 'BALANCE_RECOVERY_REQUIRES_CAPABILITY_RECOVERY'; end if;
  if settlement.status <> 'retry' or settlement.stripe_transfer_id is not null
    or not exists (select 1 from public.ad_settlement_state
      where ad_id = settlement.ad_id and active_settlement_id = settlement.id)
  then raise exception 'RECOVERY_REQUIRES_ACTIVE_RETRY'; end if;
  if guard.manual_review or guard.first_attempt_at is null
    or guard.first_attempt_at + interval '20 hours' <= now() + interval '1 minute'
    or exists (select 1 from public.wallet_payment_risks where resolved_at is null)
  then raise exception 'RECOVERY_BLOCKED_BY_TRANSFER_GUARD'; end if;
  if not exists (select 1 from public.creator_accounts
    where user_id = settlement.creator_user_id and stripe_account_id = guard.destination
      and onboarding_complete and charges_enabled and payouts_enabled)
  then raise exception 'RECOVERY_DESTINATION_NOT_READY'; end if;
  if p_available_cents is null or p_available_cents < settlement.creator_transfer_cents
  then raise exception 'RECOVERY_AVAILABLE_BALANCE_TOO_LOW'; end if;
  if guard.balance_recovery_key is not null then
    return jsonb_build_object('idempotency_key', guard.balance_recovery_key, 'created', false);
  end if;
  recovery_key := 'adbattle-settlement-' || p_settlement_id::text || '-balance-recovery-1';
  update public.wallet_transfer_guards set balance_recovery_key = recovery_key,
    balance_recovery_request_id = p_stripe_request_id,
    balance_recovery_balance_request_id = p_balance_request_id,
    balance_recovery_available_cents = p_available_cents,
    balance_recovered_at = now() where settlement_id = p_settlement_id;
  -- Preserve every predecessor key and its evidence. No accounting, destination,
  -- next_attempt_at, original first_attempt_at, or hold flags are changed.
  return jsonb_build_object('idempotency_key', recovery_key, 'created', true);
end;
$$;

revoke all on function public.prepare_wallet_transfer_before_balance_recovery(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_wallet_transfer(uuid),
  public.authorize_wallet_balance_recovery(uuid,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.prepare_wallet_transfer(uuid),
  public.authorize_wallet_balance_recovery(uuid,text,text,text,bigint,text) to service_role;
commit;

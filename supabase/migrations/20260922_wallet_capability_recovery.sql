-- Apply once after the ledger and safety migrations. Does not authorize any
-- recovery or change a balance by itself. Existing retry deadlines stay intact.
begin;

alter table public.wallet_transfer_guards
  add column capability_recovery_key text unique,
  add column capability_recovery_request_id text,
  add column capability_recovered_at timestamptz;

alter function public.prepare_wallet_transfer(uuid)
  rename to prepare_wallet_transfer_before_recovery;

create function public.prepare_wallet_transfer(p_settlement_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; recovery_key text;
begin
  -- The existing function locks settlement then guard and applies every hold.
  result := public.prepare_wallet_transfer_before_recovery(p_settlement_id);
  if not (result->>'allowed')::boolean then return result; end if;
  select capability_recovery_key into recovery_key
    from public.wallet_transfer_guards where settlement_id = p_settlement_id;
  return result || jsonb_build_object('idempotency_key', coalesce(recovery_key,
    'adbattle-settlement-' || p_settlement_id::text));
end;
$$;

-- Only the authenticated test-mode worker calls this, after an actual Stripe
-- POST with the ORIGINAL key returns the specific definitive HTTP 400 rejection.
-- Never use this RPC to recover timeouts, 5xx, ledger errors, or unknown outcomes.
create function public.authorize_wallet_capability_recovery(
  p_settlement_id uuid, p_failed_key text, p_stripe_request_id text,
  p_error_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare settlement public.support_settlements%rowtype;
  guard public.wallet_transfer_guards%rowtype; recovery_key text;
begin
  if p_error_code is distinct from 'insufficient_capabilities_for_transfer'
    or p_failed_key is distinct from 'adbattle-settlement-' || p_settlement_id::text
    or p_stripe_request_id is null or p_stripe_request_id !~ '^req_[A-Za-z0-9]+$'
  then raise exception 'INVALID_CAPABILITY_REJECTION_EVIDENCE'; end if;
  select * into settlement from public.support_settlements
    where id = p_settlement_id for update;
  if not found then raise exception 'SETTLEMENT_NOT_FOUND'; end if;
  select * into guard from public.wallet_transfer_guards
    where settlement_id = p_settlement_id for update;
  if not found then raise exception 'TRANSFER_GUARD_NOT_FOUND'; end if;
  if settlement.status <> 'retry' or settlement.stripe_transfer_id is not null
    or not exists (select 1 from public.ad_settlement_state
      where ad_id = settlement.ad_id and active_settlement_id = settlement.id)
  then raise exception 'RECOVERY_REQUIRES_ACTIVE_RETRY'; end if;
  if guard.manual_review or guard.first_attempt_at is null
    or guard.first_attempt_at + interval '20 hours' <= now() + interval '1 minute'
    or exists (select 1 from public.wallet_payment_risks where resolved_at is null)
  then raise exception 'RECOVERY_BLOCKED_BY_TRANSFER_GUARD'; end if;
  if not exists (select 1 from public.creator_accounts
    where user_id = settlement.creator_user_id and nullif(stripe_account_id, '') is not null
      and onboarding_complete and charges_enabled and payouts_enabled)
  then raise exception 'RECOVERY_CREATOR_NOT_READY'; end if;
  -- Concurrent/repeated authorization retains the ONE persisted replacement.
  if guard.capability_recovery_key is not null then
    return jsonb_build_object('idempotency_key', guard.capability_recovery_key,
      'created', false);
  end if;
  recovery_key := 'adbattle-settlement-' || p_settlement_id::text || '-capability-recovery-1';
  update public.wallet_transfer_guards set capability_recovery_key = recovery_key,
    capability_recovery_request_id = p_stripe_request_id,
    capability_recovered_at = now() where settlement_id = p_settlement_id;
  -- Keep next_attempt_at, original first_attempt_at, holds, destination and all
  -- accounting untouched. A later normal worker run uses the persisted key.
  return jsonb_build_object('idempotency_key', recovery_key, 'created', true);
end;
$$;

revoke all on function public.prepare_wallet_transfer_before_recovery(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_wallet_transfer(uuid),
  public.authorize_wallet_capability_recovery(uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.prepare_wallet_transfer(uuid),
  public.authorize_wallet_capability_recovery(uuid,text,text,text) to service_role;
commit;

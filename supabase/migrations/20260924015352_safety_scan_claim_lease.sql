-- Serialize safety scans before any paid provider call. The lease is longer
-- than Supabase's hosted Edge Function wall-clock maximum (400 seconds), so a
-- live worker cannot overlap a replacement worker. A later delivery may still
-- recover a worker that was terminated without releasing its claim.
begin;

alter table public.ads
  add column safety_scan_claim_token uuid,
  add column safety_scan_claimed_at timestamptz,
  add column safety_scan_lease_expires_at timestamptz,
  add column safety_scan_final_payload jsonb,
  add column safety_scan_final_result jsonb;

create index ads_pending_safety_scan_lease_idx
  on public.ads(safety_scan_lease_expires_at)
  where safety_status = 'pending';

revoke update (
  safety_scan_claim_token,
  safety_scan_claimed_at,
  safety_scan_lease_expires_at,
  safety_scan_final_payload,
  safety_scan_final_result
) on public.ads from anon, authenticated;

-- Authenticated users retain INSERT for posting ads. Stamp every scanner-owned
-- evidence, attempt, lease, and result field rather than trusting INSERT input.
create function public.stamp_ad_safety_scan_internal_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.moderation_reason := null;
  new.moderation_details := null;
  new.moderation_risk_score := null;
  new.moderation_scan_version := null;
  new.moderation_image_sha256 := null;
  new.moderation_last_error := null;
  new.moderation_attempts := 0;
  new.moderation_last_attempt_at := null;
  new.moderated_at := null;
  new.promotion_stopped_at := null;
  new.safety_scan_claim_token := null;
  new.safety_scan_claimed_at := null;
  new.safety_scan_lease_expires_at := null;
  new.safety_scan_final_payload := null;
  new.safety_scan_final_result := null;
  return new;
end;
$$;

create trigger stamp_ad_safety_scan_internal_fields
before insert on public.ads
for each row execute function public.stamp_ad_safety_scan_internal_fields();

revoke all on function public.stamp_ad_safety_scan_internal_fields()
from public, anon, authenticated;

-- Once the token-bound finalization commits, reject direct writes from an
-- already-running legacy worker. The independent duplicate scanner may still
-- append its duplicate_check member once, and later moderation flows
-- may advance safety/moderation state without rewriting scanner evidence.
create function public.protect_finalized_safety_scan_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Duplicate evidence is append-once and remains immutable regardless of
  -- whether safety has finalized. This fences legacy whole-column writes that
  -- would otherwise erase an independently completed duplicate scan.
  if coalesce(old.moderation_details, '{}'::jsonb) ? 'duplicate_check'
     and (
       not (coalesce(new.moderation_details, '{}'::jsonb) ? 'duplicate_check')
       or new.moderation_details->'duplicate_check'
            is distinct from old.moderation_details->'duplicate_check'
     ) then
    raise exception 'DUPLICATE_SCAN_EVIDENCE_IMMUTABLE';
  end if;

  if old.safety_scan_final_payload is not null then
    if new.moderation_reason is distinct from old.moderation_reason
       or new.moderation_risk_score is distinct from old.moderation_risk_score
       or new.moderation_scan_version is distinct from old.moderation_scan_version
       or new.moderation_image_sha256 is distinct from old.moderation_image_sha256
       or new.moderation_last_error is distinct from old.moderation_last_error
       or new.moderation_attempts is distinct from old.moderation_attempts
       or new.moderation_last_attempt_at is distinct from old.moderation_last_attempt_at
       or new.safety_scan_claim_token is distinct from old.safety_scan_claim_token
       or new.safety_scan_claimed_at is distinct from old.safety_scan_claimed_at
       or new.safety_scan_lease_expires_at is distinct from old.safety_scan_lease_expires_at
       or new.safety_scan_final_payload is distinct from old.safety_scan_final_payload
       or new.safety_scan_final_result is distinct from old.safety_scan_final_result then
      raise exception 'FINALIZED_SAFETY_EVIDENCE_IMMUTABLE';
    end if;

    if new.moderation_details is distinct from old.moderation_details then
      if (coalesce(new.moderation_details, '{}'::jsonb) - 'duplicate_check')
           is distinct from
           (coalesce(old.moderation_details, '{}'::jsonb) - 'duplicate_check')
         or coalesce(old.moderation_details, '{}'::jsonb) ? 'duplicate_check'
         or not (coalesce(new.moderation_details, '{}'::jsonb) ? 'duplicate_check')
         or old.duplicate_status <> 'pending'
         or new.duplicate_status not in (
           'passed',
           'review_identical',
           'review_similar',
           'duplicate_same_creator'
         )
         or jsonb_typeof(new.moderation_details->'duplicate_check') <> 'object'
         or new.moderation_details#>>'{duplicate_check,status}'
              is distinct from new.duplicate_status
         or (new.moderation_details#>>'{duplicate_check,matched_ad_id}')::bigint
              is distinct from new.duplicate_of_ad_id
         or new.moderation_details#>>'{duplicate_check,hash_version}'
              is distinct from 'dhash-9x8-luma-v1' then
        raise exception 'FINALIZED_SAFETY_EVIDENCE_IMMUTABLE';
      end if;
    end if;

    if new.promotion_stopped_at is distinct from old.promotion_stopped_at
       and not (
         old.promotion_stopped_at is null
         and new.promotion_stopped_at is not null
         and (new.safety_status = 'failed' or new.moderation_status = 'removed')
       ) then
      raise exception 'FINALIZED_SAFETY_PROMOTION_STATE_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$;

create trigger protect_finalized_safety_scan_evidence
before update on public.ads
for each row execute function public.protect_finalized_safety_scan_evidence();

revoke all on function public.protect_finalized_safety_scan_evidence()
from public, anon, authenticated;

create function public.claim_ad_safety_scan(
  p_ad_id bigint,
  p_claim_token uuid,
  p_scan_version text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.ads%rowtype;
  claimed_at timestamptz;
  lease_expires_at timestamptz;
  recovered_stale boolean := false;
begin
  if p_ad_id is null or p_claim_token is null
     or length(btrim(coalesce(p_scan_version, ''))) not between 1 and 200 then
    raise exception 'INVALID_SAFETY_SCAN_CLAIM';
  end if;

  select * into target from public.ads where id = p_ad_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Capture time only after acquiring the row lock. A contending claim may
  -- wait here, and must receive a full lease from the time it actually owns it.
  claimed_at := clock_timestamp();

  if target.safety_status <> 'pending' then
    return jsonb_build_object(
      'result', 'terminal',
      'safety_status', target.safety_status
    );
  end if;

  -- Replaying the same claim after its response was lost must not count as a
  -- second attempt or rotate the token.
  if target.safety_scan_claim_token = p_claim_token
     and target.safety_scan_lease_expires_at > claimed_at then
    if target.moderation_scan_version is distinct from p_scan_version then
      raise exception 'SAFETY_SCAN_CLAIM_CONFLICT';
    end if;
    return jsonb_build_object(
      'result', 'claimed',
      'replayed', true,
      'recovered_stale', false,
      'lease_expires_at', target.safety_scan_lease_expires_at
    );
  end if;

  if target.safety_scan_claim_token is not null
     and target.safety_scan_lease_expires_at > claimed_at then
    return jsonb_build_object(
      'result', 'busy',
      'lease_expires_at', target.safety_scan_lease_expires_at
    );
  end if;

  recovered_stale := target.safety_scan_claim_token is not null;
  lease_expires_at := claimed_at + interval '10 minutes';

  update public.ads
    set safety_scan_claim_token = p_claim_token,
        safety_scan_claimed_at = claimed_at,
        safety_scan_lease_expires_at = lease_expires_at,
        moderation_attempts = moderation_attempts + 1,
        moderation_last_attempt_at = claimed_at,
        moderation_last_error = null,
        moderation_scan_version = p_scan_version
    where id = p_ad_id;

  return jsonb_build_object(
    'result', 'claimed',
    'replayed', false,
    'recovered_stale', recovered_stale,
    'lease_expires_at', lease_expires_at
  );
end;
$$;

create function public.finalize_ad_safety_scan(
  p_ad_id bigint,
  p_claim_token uuid,
  p_status text,
  p_reason text,
  p_risk_score integer,
  p_image_sha256 text,
  p_details jsonb,
  p_scan_version text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.ads%rowtype;
  final_outcome text;
  final_payload jsonb;
  final_result jsonb;
begin
  if p_ad_id is null or p_claim_token is null
     or p_status is null or p_status not in ('passed', 'held', 'failed')
     or p_risk_score is null or p_risk_score not between 0 and 100
     or length(btrim(coalesce(p_scan_version, ''))) not between 1 and 200
     or (p_reason is not null and length(p_reason) > 1000)
     or (p_status in ('passed', 'held') and p_image_sha256 is null)
     or (p_image_sha256 is not null and p_image_sha256 !~ '^[0-9a-f]{64}$')
     or (p_details is not null and jsonb_typeof(p_details) <> 'object')
     or coalesce(p_details, '{}'::jsonb) ? 'duplicate_check' then
    raise exception 'INVALID_SAFETY_SCAN_FINALIZATION';
  end if;

  select * into target from public.ads where id = p_ad_id for update;
  if not found then raise exception 'AD_NOT_FOUND'; end if;

  final_payload := jsonb_build_object(
    'status', p_status,
    'reason', p_reason,
    'risk_score', p_risk_score,
    'image_sha256', p_image_sha256,
    'details', p_details,
    'scan_version', p_scan_version
  );

  if target.safety_status <> 'pending' then
    -- Return the exact canonical response even if later human review changed
    -- the held safety state. A reused token with a different payload conflicts.
    if target.safety_scan_claim_token = p_claim_token
       and target.safety_scan_final_payload = final_payload
       and target.safety_scan_final_result is not null then
      return target.safety_scan_final_result
        || jsonb_build_object('result', 'replayed');
    end if;
    raise exception 'SAFETY_FINALIZATION_CONFLICT';
  end if;

  if target.safety_scan_claim_token is distinct from p_claim_token then
    raise exception 'SAFETY_SCAN_CLAIM_LOST';
  end if;
  if target.moderation_scan_version is distinct from p_scan_version then
    raise exception 'SAFETY_SCAN_CLAIM_CONFLICT';
  end if;

  update public.ads
    set safety_status = p_status,
        moderation_reason = p_reason,
        -- Preserve only independent duplicate evidence. Any safety-shaped
        -- metadata left by an old pre-lease worker is replaced canonically.
        moderation_details = case
          when coalesce(moderation_details, '{}'::jsonb) ? 'duplicate_check'
            then jsonb_build_object(
              'duplicate_check', moderation_details->'duplicate_check'
            )
          else '{}'::jsonb
        end || coalesce(p_details, '{}'::jsonb),
        moderation_risk_score = p_risk_score,
        moderation_scan_version = p_scan_version,
        moderation_image_sha256 = p_image_sha256,
        moderation_last_error = null,
        moderated_at = clock_timestamp(),
        promotion_stopped_at = case
          when p_status = 'failed' then clock_timestamp()
          else promotion_stopped_at
        end,
        safety_scan_lease_expires_at = null
    where id = p_ad_id;

  perform public.refresh_ad_moderation_status(p_ad_id);

  final_outcome := case p_status
    when 'passed' then 'approved'
    when 'held' then 'manual_review'
    else 'rejected'
  end;

  insert into public.moderation_events(ad_id, stage, outcome, reason, details)
    values (
      p_ad_id,
      'final_decision',
      final_outcome,
      p_reason,
      jsonb_build_object(
        'risk_score', p_risk_score,
        'image_sha256', p_image_sha256
      )
    );

  select * into target from public.ads where id = p_ad_id;
  final_result := jsonb_build_object(
    'result', 'finalized',
    'safety_status', target.safety_status,
    'moderation_status', target.moderation_status
  );

  update public.ads
    set safety_scan_final_payload = final_payload,
        safety_scan_final_result = final_result
    where id = p_ad_id;

  return final_result;
end;
$$;

create function public.record_ad_safety_scan_failure(
  p_ad_id bigint,
  p_claim_token uuid,
  p_error text,
  p_scan_version text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.ads%rowtype;
  safe_error text := left(coalesce(p_error, 'Unknown scanner error'), 1000);
begin
  if p_ad_id is null or p_claim_token is null
     or length(btrim(coalesce(p_scan_version, ''))) not between 1 and 200 then
    raise exception 'INVALID_SAFETY_SCAN_FAILURE';
  end if;

  select * into target from public.ads where id = p_ad_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if target.safety_status <> 'pending' then
    return jsonb_build_object(
      'result', 'terminal',
      'safety_status', target.safety_status
    );
  end if;
  if target.safety_scan_claim_token is distinct from p_claim_token then
    return jsonb_build_object('result', 'claim_lost');
  end if;

  update public.ads
    set moderation_last_error = safe_error,
        moderation_last_attempt_at = clock_timestamp(),
        moderation_scan_version = p_scan_version,
        safety_scan_claim_token = null,
        safety_scan_claimed_at = null,
        safety_scan_lease_expires_at = null
    where id = p_ad_id;

  insert into public.moderation_events(ad_id, stage, outcome, reason, details)
    values (p_ad_id, 'error', 'temporary_error', safe_error, null);

  return jsonb_build_object('result', 'released');
end;
$$;

revoke all on function
  public.claim_ad_safety_scan(bigint, uuid, text),
  public.finalize_ad_safety_scan(bigint, uuid, text, text, integer, text, jsonb, text),
  public.record_ad_safety_scan_failure(bigint, uuid, text, text)
from public, anon, authenticated;

-- Remove the legacy unleased finalization path. Deploy this migration before
-- deploying the worker that calls the new RPCs; an in-flight old worker then
-- fails closed and a later claimed worker safely replaces it.
revoke execute on function public.record_ad_safety_scan(bigint, text, text)
from service_role;

grant execute on function
  public.claim_ad_safety_scan(bigint, uuid, text),
  public.finalize_ad_safety_scan(bigint, uuid, text, text, integer, text, jsonb, text),
  public.record_ad_safety_scan_failure(bigint, uuid, text, text)
to service_role;

commit;

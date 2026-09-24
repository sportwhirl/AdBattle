-- Server-owned age gate foundation. Apply to staging only after the release
-- checklist; this migration does not turn on an AI feature or classify users.
-- Existing accounts have no row and therefore no adult capabilities.
begin;

create schema age_private;
revoke all on schema age_private from public, anon, authenticated, service_role;
grant usage on schema age_private to service_role;

-- No date of birth, guardian identity, child contact, or raw verification
-- payload is stored. A trusted age-assessment flow must populate this table.
create table age_private.age_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  age_band text not null default 'unknown'
    check (age_band in ('unknown', 'below_local_consent', 'minor_eligible', 'adult')),
  state text not null default 'pending'
    check (state in ('pending', 'active', 'blocked', 'revoked')),
  assessment_method text check (assessment_method in (
    'verified_provider', 'manual_staff_review', 'legacy_verified_adult'
  )),
  jurisdiction text check (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{2,8})?$'),
  policy_version text check (policy_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  assessed_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint active_age_assessment_required check (
    state <> 'active' or
    (assessment_method is not null and jurisdiction is not null
      and policy_version is not null and assessed_at is not null
      and expires_at is not null and expires_at > assessed_at
      and revoked_at is null)
  )
);

-- Explicit, narrow, independently expiring grants. There is no wildcard
-- scope. Youth consent will need a separate verified guardian flow later.
create table age_private.capability_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references age_private.age_entitlements(user_id)
    on delete cascade,
  scope text not null check (scope in (
    'ai_image_generate', 'ai_image_submit',
    'ai_video_create', 'ai_video_dispatch', 'ai_video_publish',
    'ordinary_upload', 'ordinary_post', 'creator_profile',
    'financial_support', 'financial_seed', 'wallet_topup',
    'connect_onboarding', 'payout'
  )),
  provider_route text not null
    check (provider_route in ('openai_images', 'still_animation', 'luma_video', 'none')),
  entitlement_version bigint not null check (entitlement_version > 0),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  grant_reason text not null check (grant_reason in (
    'adult_staging_tester', 'adult_general_access', 'manual_renewal'
  )),
  constraint grant_expiry_after_issuance check (expires_at > granted_at),
  constraint revoke_after_issuance check (revoked_at is null or revoked_at >= granted_at),
  -- New external providers require a reviewed migration and new grants.
  constraint age_scope_provider_route check (
    (scope in ('ai_image_generate', 'ai_image_submit')
      and provider_route = 'openai_images') or
    (scope in ('ai_video_create', 'ai_video_dispatch', 'ai_video_publish')
      and provider_route in ('still_animation', 'luma_video')) or
    (scope in ('ordinary_upload', 'ordinary_post', 'creator_profile',
      'financial_support', 'financial_seed', 'wallet_topup',
      'connect_onboarding', 'payout')
      and provider_route = 'none')
  )
);
create unique index age_one_live_grant_per_scope_version
  on age_private.capability_grants(user_id, scope, provider_route, entitlement_version)
  where revoked_at is null;
create index age_capability_grants_lookup
  on age_private.capability_grants(user_id, scope, provider_route)
  where revoked_at is null;

-- A reclassification, expiry edit, block, or reactivation invalidates grants
-- issued against the old entitlement version. This prevents revocation from
-- being undone by changing state back to active later.
create function age_private.entitlement_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.age_band, new.state, new.assessment_method, new.jurisdiction,
      new.policy_version, new.assessed_at, new.expires_at, new.revoked_at)
      is distinct from
     (old.age_band, old.state, old.assessment_method, old.jurisdiction,
      old.policy_version, old.assessed_at, old.expires_at, old.revoked_at) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
create trigger age_entitlement_update
  before update on age_private.age_entitlements
  for each row execute function age_private.entitlement_before_update();

-- A grant can only move from live to revoked; issuance details and revocation
-- are permanent. A new issuance is a new row, leaving the old one audit-able.
create function age_private.grant_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.user_id, new.scope, new.provider_route, new.entitlement_version,
      new.granted_at, new.expires_at, new.grant_reason)
      is distinct from
     (old.id, old.user_id, old.scope, old.provider_route, old.entitlement_version,
      old.granted_at, old.expires_at, old.grant_reason)
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
    or (old.revoked_at is null and new.revoked_at is not null
      and new.revoked_at < old.granted_at) then
    raise exception 'AGE_GRANT_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger age_capability_grant_update
  before update on age_private.capability_grants
  for each row execute function age_private.grant_before_update();

alter table age_private.age_entitlements enable row level security;
alter table age_private.capability_grants enable row level security;
revoke all on age_private.age_entitlements, age_private.capability_grants
  from public, anon, authenticated, service_role;
grant select, insert, update on age_private.age_entitlements,
  age_private.capability_grants to service_role;
create policy age_service_access on age_private.age_entitlements
  for all to service_role using (true) with check (true);
create policy age_grant_service_access on age_private.capability_grants
  for all to service_role using (true) with check (true);

-- Service-only invoker lookup against current database state. Checking an Auth
-- user's current disable/delete status avoids relying on a stale JWT. The
-- caller must validate the JWT/session and derive p_user_id server-side.
grant usage on schema auth to service_role;
grant select (id, is_anonymous, deleted_at, banned_until)
  on auth.users to service_role;
create function age_private.has_adult_entitlement(
  p_user_id uuid, p_scope text, p_provider_route text
) returns boolean
language plpgsql volatile security invoker set search_path = '' as $$
declare checked_at timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_scope is null or p_provider_route is null then
    return false;
  end if;
  return exists (
    select 1 from age_private.age_entitlements e
      join age_private.capability_grants g on g.user_id = e.user_id
        and g.entitlement_version = e.version
      join auth.users u on u.id = e.user_id
    where e.user_id = p_user_id and e.age_band = 'adult' and e.state = 'active'
      and e.revoked_at is null and e.assessed_at <= checked_at
      and e.expires_at > checked_at
      and g.scope = p_scope and g.provider_route = p_provider_route
      and g.revoked_at is null
      and g.granted_at <= checked_at and g.expires_at > checked_at
      and coalesce(u.is_anonymous, false) = false
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= checked_at)
  );
end
$$;

-- The Data API exposes public RPCs, not private-schema RPCs. This invoker
-- wrapper is executable only with the server's service_role credentials.
create function public.has_adult_entitlement(
  p_user_id uuid, p_scope text, p_provider_route text
) returns boolean
language sql volatile security invoker set search_path = '' as $$
  select age_private.has_adult_entitlement(p_user_id, p_scope, p_provider_route)
$$;
revoke all on all functions in schema age_private
  from public, anon, authenticated, service_role;
grant execute on function age_private.has_adult_entitlement(uuid, text, text)
  to service_role;
revoke all on function public.has_adult_entitlement(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.has_adult_entitlement(uuid, text, text)
  to service_role;
commit;

-- Duplicate-image screening and creator attribution. This migration only
-- prepares data structures/functions; it does not enable storage or deploy a scanner.
begin;

alter table public.ads
  add column if not exists image_storage_path text,
  add column if not exists safety_status text,
  add column if not exists duplicate_status text,
  add column if not exists duplicate_of_ad_id bigint references public.ads(id) on delete set null;

update public.ads set
  safety_status = case when moderation_status = 'approved' then 'passed'
    when moderation_status in ('rejected','removed') then 'failed' else 'pending' end,
  duplicate_status = case when moderation_status = 'approved' then 'passed' else 'pending' end
where safety_status is null or duplicate_status is null;

alter table public.ads
  alter column safety_status set default 'pending',
  alter column safety_status set not null,
  alter column duplicate_status set default 'pending',
  alter column duplicate_status set not null,
  add constraint ads_safety_status_valid check (safety_status in ('pending','passed','held','failed')),
  add constraint ads_duplicate_status_valid check (duplicate_status in
    ('pending','passed','review_identical','review_similar','duplicate_same_creator'));

create table public.ad_image_fingerprints (
  ad_id bigint primary key references public.ads(id) on delete cascade,
  sha256 bytea not null check (octet_length(sha256) = 32),
  visual_hash bit(64) not null,
  visual_hash_version text not null,
  scanned_at timestamptz not null default now()
);
create index ad_image_fingerprints_sha256_idx on public.ad_image_fingerprints(sha256);
create index ads_duplicate_review_idx on public.ads(duplicate_status)
  where duplicate_status in ('review_identical','review_similar');

create table public.ad_scan_attempts (
  id bigint generated always as identity primary key,
  ad_id bigint not null references public.ads(id) on delete cascade,
  outcome text not null check (outcome in ('completed','failed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.ad_image_index_state (
  singleton boolean primary key default true check (singleton),
  ready boolean not null default false,
  completed_at timestamptz,
  notes text
);
insert into public.ad_image_index_state(singleton,ready,notes)
  values(true,false,'Existing-image backfill has not been verified');

-- The supplied schema has no creator display-name field. Add a narrowly scoped,
-- owner-maintained profile rather than deriving a public name from email/auth data.
create table public.creator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text not null check (handle ~ '^[A-Za-z0-9_]{1,30}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index creator_profiles_handle_lower_uidx on public.creator_profiles(lower(handle));

alter table public.ad_image_fingerprints enable row level security;
alter table public.ad_scan_attempts enable row level security;
alter table public.ad_image_index_state enable row level security;
alter table public.creator_profiles enable row level security;
revoke all on public.ad_image_fingerprints, public.ad_scan_attempts,
  public.ad_image_index_state from public, anon, authenticated;
grant all on public.ad_image_fingerprints, public.ad_scan_attempts,
  public.ad_image_index_state to service_role;
revoke all on public.creator_profiles from anon, authenticated;
grant select on public.creator_profiles to anon, authenticated;
grant insert, update on public.creator_profiles to authenticated;
grant all on public.creator_profiles to service_role;
create policy "Creator profiles are public" on public.creator_profiles for select using (true);
create policy "Creators insert their profile" on public.creator_profiles for insert to authenticated
  with check (auth.uid() = user_id);
create policy "Creators update their profile" on public.creator_profiles for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.enforce_ad_screening_gate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.safety_status := 'pending';
    new.duplicate_status := 'pending';
    new.duplicate_of_ad_id := null;
    new.moderation_status := 'pending_scan';
  elsif new.moderation_status = 'approved'
        and (new.safety_status <> 'passed' or new.duplicate_status <> 'passed') then
    raise exception 'REQUIRED_SCREENING_INCOMPLETE';
  end if;
  return new;
end;
$$;
create trigger enforce_ad_screening_gate
before insert or update on public.ads for each row execute function public.enforce_ad_screening_gate();

create or replace function public.refresh_ad_moderation_status(p_ad_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ads set
    moderation_status = case
      when moderation_status = 'removed' then 'removed'
      when safety_status = 'failed' then 'rejected'
      when safety_status = 'passed' and duplicate_status = 'passed' then 'approved'
      else 'pending_scan'
    end,
    moderated_at = case when safety_status = 'passed' and duplicate_status = 'passed'
      then now() else moderated_at end
  where id = p_ad_id;
end;
$$;

create or replace function public.record_ad_duplicate_scan(
  p_ad_id bigint, p_sha256_hex text, p_visual_hash_hex text, p_visual_hash_version text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target public.ads%rowtype;
  exact_match record;
  visual_match record;
  result_status text;
  matched_id bigint;
  distance integer;
begin
  if p_sha256_hex !~ '^[0-9a-f]{64}$' or p_visual_hash_hex !~ '^[0-9a-f]{16}$'
     or p_visual_hash_version <> 'dhash-9x8-luma-v1' then
    raise exception 'INVALID_FINGERPRINT';
  end if;
  select * into target from public.ads where id = p_ad_id for update;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  if target.duplicate_status <> 'pending' then
    return jsonb_build_object('status', target.duplicate_status, 'matched_ad_id', target.duplicate_of_ad_id);
  end if;
  -- Serialize index decisions so simultaneous exact or visual matches cannot
  -- both observe an empty index and pass.
  perform pg_advisory_xact_lock(hashtextextended('ad-image-scan-v1', 0));

  select a.id, a.user_id into exact_match
    from public.ad_image_fingerprints f join public.ads a on a.id = f.ad_id
    where f.sha256 = decode(p_sha256_hex, 'hex') and a.id <> p_ad_id
    order by a.created_at, a.id limit 1;
  if found then
    matched_id := exact_match.id;
    result_status := case when exact_match.user_id = target.user_id
      then 'duplicate_same_creator' else 'review_identical' end;
    distance := 0;
  else
    select a.id, bit_count(f.visual_hash # (('x' || p_visual_hash_hex)::bit(64)))::integer as d
      into visual_match
      from public.ad_image_fingerprints f join public.ads a on a.id = f.ad_id
      where f.visual_hash_version = p_visual_hash_version and a.id <> p_ad_id
        and bit_count(f.visual_hash # (('x' || p_visual_hash_hex)::bit(64))) <= 8
      order by d, a.created_at, a.id limit 1;
    if found then
      result_status := 'review_similar'; matched_id := visual_match.id; distance := visual_match.d;
    else
      result_status := 'passed';
    end if;
  end if;

  insert into public.ad_image_fingerprints(ad_id,sha256,visual_hash,visual_hash_version)
    values (p_ad_id,decode(p_sha256_hex,'hex'),(('x'||p_visual_hash_hex)::bit(64)),p_visual_hash_version);
  update public.ads set duplicate_status=result_status, duplicate_of_ad_id=matched_id,
    moderation_details=coalesce(moderation_details,'{}'::jsonb) || jsonb_build_object(
      'duplicate_check',jsonb_build_object('status',result_status,'matched_ad_id',matched_id,
        'visual_distance',distance,'hash_version',p_visual_hash_version))
    where id=p_ad_id;
  insert into public.ad_scan_attempts(ad_id,outcome,details) values
    (p_ad_id,'completed',jsonb_build_object('status',result_status,'matched_ad_id',matched_id,'visual_distance',distance));
  perform public.refresh_ad_moderation_status(p_ad_id);
  return jsonb_build_object('status',result_status,'matched_ad_id',matched_id,'visual_distance',distance);
end;
$$;

create or replace function public.record_ad_duplicate_scan_failure(p_ad_id bigint,p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Deliberately does not change duplicate_status from pending.
  insert into public.ad_scan_attempts(ad_id,outcome,details)
    values(p_ad_id,'failed',jsonb_build_object('error',left(coalesce(p_error,'Unknown error'),500)));
  perform public.refresh_ad_moderation_status(p_ad_id);
end;
$$;

create or replace function public.record_ad_safety_scan(p_ad_id bigint,p_status text,p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('passed','held','failed') then raise exception 'INVALID_SAFETY_STATUS'; end if;
  update public.ads set safety_status=p_status, moderation_reason=p_reason where id=p_ad_id;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  perform public.refresh_ad_moderation_status(p_ad_id);
end;
$$;

revoke all on function public.refresh_ad_moderation_status(bigint),
  public.record_ad_duplicate_scan(bigint,text,text,text),
  public.record_ad_duplicate_scan_failure(bigint,text),
  public.record_ad_safety_scan(bigint,text,text) from public,anon,authenticated;
grant execute on function public.record_ad_duplicate_scan(bigint,text,text,text),
  public.record_ad_duplicate_scan_failure(bigint,text),
  public.record_ad_safety_scan(bigint,text,text) to service_role;

-- Existing unindexed rows remain pending. An operator can invoke scan-ad for each
-- image after confirming storage access; approval is never inferred by this backfill.
commit;

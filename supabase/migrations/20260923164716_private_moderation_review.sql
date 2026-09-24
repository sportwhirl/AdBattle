-- Moderator-only review. No account receives access automatically.
-- Requires 20260922_duplicate_screening.sql. Existing scanner RPCs stay unchanged.
begin;
create schema moderation_private;
revoke all on schema moderation_private from public, anon, authenticated, service_role;
grant usage on schema moderation_private to authenticated;

create table moderation_private.reviewers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by text not null check (length(trim(granted_by)) >= 3),
  reason text not null check (length(trim(reason)) between 10 and 2000)
);
create table moderation_private.decisions (
  request_id uuid primary key,
  ad_id bigint not null references public.ads(id) on delete restrict,
  review_kind text not null check (review_kind in ('safety','duplicate')),
  decision text not null check (decision in ('clear','reject')),
  reviewer_id uuid not null, -- Retained even if the Auth account is deleted.
  reason text not null check (length(trim(reason)) between 10 and 2000),
  expected_version text not null,
  before_snapshot jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique(ad_id, review_kind)
);
alter table moderation_private.reviewers enable row level security;
alter table moderation_private.decisions enable row level security;
revoke all on all tables in schema moderation_private from public, anon, authenticated, service_role;
create index ads_safety_review_idx on public.ads(id) where safety_status='held';

-- Live membership and live session, not user-editable metadata or stale JWT roles.
-- SHARE locks serialize membership revocation/session deletion with a decision.
create function moderation_private.require_reviewer() returns uuid
language plpgsql security definer set search_path='' as $$
declare reviewer uuid := auth.uid(); session_uuid uuid;
begin
  begin
    session_uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  exception when invalid_text_representation then
    raise exception 'MODERATOR_ACCESS_REQUIRED' using errcode='42501';
  end;
  if reviewer is null or session_uuid is null then
    raise exception 'MODERATOR_ACCESS_REQUIRED' using errcode='42501';
  end if;
  perform 1 from moderation_private.reviewers m
    join auth.users u on u.id=m.user_id
    join auth.sessions s on s.user_id=u.id
    where m.user_id=reviewer and s.id=session_uuid
      and coalesce(u.is_anonymous,false)=false
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and (s.not_after is null or s.not_after > now())
    for share of m,u,s;
  if not found then raise exception 'MODERATOR_ACCESS_REQUIRED' using errcode='42501'; end if;
  return reviewer;
end;
$$;

-- Deliberately excludes monetary totals: new Support must not stale a review.
create function moderation_private.snapshot(p_ad_id bigint) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',a.id::text,'owner_id',a.user_id,'title',a.title,'caption',a.caption,
    'image_url',a.image_url,'image_storage_path',a.image_storage_path,
    'created_at',a.created_at,'promotion_allocation',a.promotion_allocation,
    'moderation_status',a.moderation_status,'safety_status',a.safety_status,
    'duplicate_status',a.duplicate_status,'duplicate_of_ad_id',a.duplicate_of_ad_id::text,
    'reason',a.moderation_reason,'details',a.moderation_details,
    'risk_score',a.moderation_risk_score,'scan_version',a.moderation_scan_version,
    'image_sha256',a.moderation_image_sha256,'last_error',a.moderation_last_error,
    'matched_ad',case when b.id is null then null else jsonb_build_object(
      'id',b.id::text,'owner_id',b.user_id,'title',b.title,'caption',b.caption,
      'image_url',b.image_url,'image_storage_path',b.image_storage_path,
      'created_at',b.created_at,'moderation_status',b.moderation_status) end)
  from public.ads a left join public.ads b on b.id=a.duplicate_of_ad_id
  where a.id=p_ad_id
$$;

create function moderation_private.access() returns jsonb
language plpgsql security definer set search_path='' as $$
begin return jsonb_build_object('reviewer_id',moderation_private.require_reviewer()); end;
$$;

create function moderation_private.queue(p_after_id bigint default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare items jsonb; next_id text;
begin
  perform moderation_private.require_reviewer();
  if p_after_id is null or p_after_id < 0 then raise exception 'INVALID_PAGE'; end if;
  select coalesce(jsonb_agg(item order by id),'[]'::jsonb),max(id)::text into items,next_id
  from (select a.id,jsonb_build_object('id',a.id::text,'title',a.title,
      'safety_status',a.safety_status,'duplicate_status',a.duplicate_status,
      'reason',a.moderation_reason,'created_at',a.created_at) item
    from public.ads a where a.id>p_after_id and a.moderation_status<>'removed'
      and (a.safety_status='held' or a.duplicate_status in ('review_identical','review_similar'))
    order by a.id limit 25) page;
  return jsonb_build_object('items',items,'next_after_id',case when jsonb_array_length(items)=25 then next_id else null end);
end;
$$;

create function moderation_private.detail(p_ad_id bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare snap jsonb; history jsonb; legacy jsonb;
begin
  perform moderation_private.require_reviewer();
  snap := moderation_private.snapshot(p_ad_id);
  if snap is null then raise exception 'AD_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('request_id',request_id,'review_kind',review_kind,
    'decision',decision,'reviewer_id',reviewer_id,'reason',reason,'created_at',created_at,
    'result',result) order by created_at),'[]'::jsonb) into history
    from moderation_private.decisions where ad_id=p_ad_id;
  select to_jsonb(d) into legacy from public.ad_duplicate_review_decisions d where ad_id=p_ad_id;
  return jsonb_build_object('ad',snap,'version',md5(snap::text),'history',history,'duplicate_audit',legacy);
end;
$$;

create function moderation_private.decide(
  p_request_id uuid,p_ad_id bigint,p_review_kind text,p_decision text,p_reason text,p_expected_version text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  reviewer uuid; prior moderation_private.decisions%rowtype;
  target public.ads%rowtype; snap jsonb; result jsonb; normalized_reason text := btrim(p_reason);
begin
  reviewer := moderation_private.require_reviewer();
  if p_request_id is null or p_ad_id is null
    or p_review_kind is null or p_review_kind not in ('safety','duplicate')
    or p_decision is null or p_decision not in ('clear','reject')
    or normalized_reason is null or length(normalized_reason) not between 10 and 2000
    or p_expected_version is null or p_expected_version !~ '^[0-9a-f]{32}$' then
    raise exception 'INVALID_REVIEW';
  end if;
  -- Serializes retries even if a reused UUID supplies a different ad.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,48231));
  select * into prior from moderation_private.decisions where request_id=p_request_id;
  if found then
    if prior.ad_id<>p_ad_id or prior.review_kind<>p_review_kind or prior.decision<>p_decision
      or prior.reviewer_id<>reviewer or prior.reason<>normalized_reason
      or prior.expected_version<>p_expected_version then raise exception 'REVIEW_REQUEST_CONFLICT'; end if;
    return prior.result;
  end if;
  select * into target from public.ads where id=p_ad_id for update;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  if target.moderation_status='removed' then raise exception 'REMOVED_AD_CANNOT_BE_REVIEWED'; end if;
  if exists(select 1 from moderation_private.decisions where ad_id=p_ad_id and review_kind=p_review_kind) then
    raise exception 'REVIEW_ALREADY_RESOLVED';
  end if;
  snap := moderation_private.snapshot(p_ad_id);
  if md5(snap::text)<>p_expected_version then raise exception 'REVIEW_CHANGED_REFRESH_REQUIRED'; end if;
  if p_review_kind='safety' then
    if target.safety_status<>'held' then raise exception 'SAFETY_REVIEW_NOT_HELD'; end if;
    -- This is the sole new held->terminal path; scanner terminal rules are unchanged.
    update public.ads set safety_status=case when p_decision='clear' then 'passed' else 'failed' end
      where id=p_ad_id;
    perform public.refresh_ad_moderation_status(p_ad_id);
  else
    perform public.resolve_ad_duplicate_review(p_ad_id,p_decision,reviewer::text,normalized_reason);
  end if;
  select jsonb_build_object('ad_id',id::text,'review_kind',p_review_kind,'decision',p_decision,
    'safety_status',safety_status,'duplicate_status',duplicate_status,'moderation_status',moderation_status)
    into result from public.ads where id=p_ad_id;
  insert into moderation_private.decisions(request_id,ad_id,review_kind,decision,reviewer_id,
    reason,expected_version,before_snapshot,result)
    values(p_request_id,p_ad_id,p_review_kind,p_decision,reviewer,normalized_reason,p_expected_version,snap,result);
  insert into public.moderation_events(ad_id,stage,outcome,reason,details)
    values(p_ad_id,'human_'||p_review_kind||'_review',p_decision,normalized_reason,
      jsonb_build_object('request_id',p_request_id,'reviewer_id',reviewer,'result',result));
  return result;
end;
$$;

-- Thin invoker-only API; all elevated code and data remain in the unexposed schema.
create function public.moderator_access() returns jsonb
language sql security invoker set search_path='' as $$ select moderation_private.access() $$;
create function public.moderator_queue(p_after_id bigint default 0) returns jsonb
language sql security invoker set search_path='' as $$ select moderation_private.queue(p_after_id) $$;
create function public.moderator_ad(p_ad_id bigint) returns jsonb
language sql security invoker set search_path='' as $$ select moderation_private.detail(p_ad_id) $$;
create function public.moderator_decide(p_request_id uuid,p_ad_id bigint,p_review_kind text,
  p_decision text,p_reason text,p_expected_version text) returns jsonb
language sql security invoker set search_path='' as $$
  select moderation_private.decide(p_request_id,p_ad_id,p_review_kind,p_decision,p_reason,p_expected_version)
$$;

revoke all on all functions in schema moderation_private from public,anon,authenticated,service_role;
grant execute on function moderation_private.access(),moderation_private.queue(bigint),
  moderation_private.detail(bigint),moderation_private.decide(uuid,bigint,text,text,text,text) to authenticated;
revoke all on function public.moderator_access(),public.moderator_queue(bigint),
  public.moderator_ad(bigint),public.moderator_decide(uuid,bigint,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.moderator_access(),public.moderator_queue(bigint),
  public.moderator_ad(bigint),public.moderator_decide(uuid,bigint,text,text,text,text) to authenticated;
commit;

-- Staging image generation reservations. Apply only to adbattle-test first.
-- A private bucket keeps unreviewed drafts out of the public ad-images bucket.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai-image-drafts', 'ai-image-drafts', false, 8388608,
        array['image/jpeg', 'image/png'])
on conflict (id) do nothing;
do $$
begin
  if exists (select 1 from storage.buckets where id='ai-image-drafts'
             and (public is distinct from false or file_size_limit is distinct from 8388608
                  or allowed_mime_types is distinct from array['image/jpeg','image/png'])) then
    raise exception 'AI_DRAFT_BUCKET_MISCONFIGURED';
  end if;
end $$;

create table public.ai_image_draft_requests (
  request_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  day_utc date not null,
  prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  style text not null check (style in ('pixel_art','flat_illustration','simple_3d','hand_drawn','freeform_simple')),
  aspect_ratio text not null check (aspect_ratio in ('1:1','16:9')),
  status text not null check (status in ('reserved','completed','failed','unknown')),
  model text not null default 'gemini-3.1-flash-lite-image',
  output_path text,
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint completed_draft_has_output check
    (status <> 'completed' or (output_path is not null and output_sha256 is not null))
);
create unique index ai_image_one_active_user
  on public.ai_image_draft_requests(user_id) where status = 'reserved';
create index ai_image_daily_usage
  on public.ai_image_draft_requests(day_utc, user_id);

alter table public.ai_image_draft_requests enable row level security;
revoke all on public.ai_image_draft_requests from public, anon, authenticated;
grant select, insert, update on public.ai_image_draft_requests to service_role;

-- Service-only, serialized before any paid Gemini call. Failed and unknown
-- attempts consume quota because the provider may have charged for them.
create function public.reserve_ai_image_draft(
  p_user_id uuid, p_request_id uuid, p_prompt_sha256 text, p_style text,
  p_aspect_ratio text,
  p_user_limit integer, p_global_limit integer
) returns table(reservation_status text, draft_path text)
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_existing public.ai_image_draft_requests%rowtype;
begin
  if p_user_id is null or p_request_id is null
     or p_prompt_sha256 is null or p_prompt_sha256 !~ '^[0-9a-f]{64}$'
     or p_style is null or p_style not in ('pixel_art','flat_illustration','simple_3d','hand_drawn','freeform_simple')
     or p_aspect_ratio is null or p_aspect_ratio not in ('1:1','16:9')
     or p_user_limit is null or p_user_limit not between 1 and 3
     or p_global_limit is null or p_global_limit not between 1 and 30 then
    raise exception 'INVALID_AI_IMAGE_RESERVATION';
  end if;

  -- Serializes the global/day counts and the one-active-user check.
  perform pg_catalog.pg_advisory_xact_lock(41943, v_day - date '2000-01-01');
  update public.ai_image_draft_requests
     set status='unknown', updated_at=now()
   where status='reserved' and updated_at < now() - interval '3 minutes';

  select * into v_existing from public.ai_image_draft_requests
   where request_id=p_request_id for update;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.prompt_sha256 <> p_prompt_sha256
       or v_existing.style <> p_style or v_existing.aspect_ratio <> p_aspect_ratio then
      raise exception 'AI_IMAGE_REQUEST_CONFLICT';
    end if;
    return query select
      case when v_existing.status='reserved' then 'reserved_replay' else v_existing.status end,
      v_existing.output_path;
    return;
  end if;

  if (select count(*) from public.ai_image_draft_requests
       where day_utc=v_day and user_id=p_user_id) >= p_user_limit then
    return query select 'user_limit'::text, null::text;
    return;
  end if;
  if (select count(*) from public.ai_image_draft_requests where day_utc=v_day) >= p_global_limit then
    return query select 'global_limit'::text, null::text;
    return;
  end if;
  if exists (select 1 from public.ai_image_draft_requests
              where user_id=p_user_id and status='reserved') then
    return query select 'active'::text, null::text;
    return;
  end if;

  insert into public.ai_image_draft_requests
    (request_id,user_id,day_utc,prompt_sha256,style,aspect_ratio,status)
  values (p_request_id,p_user_id,v_day,p_prompt_sha256,p_style,p_aspect_ratio,'reserved');
  return query select 'reserved'::text, null::text;
end;
$$;
revoke all on function public.reserve_ai_image_draft(uuid,uuid,text,text,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.reserve_ai_image_draft(uuid,uuid,text,text,text,integer,integer)
  to service_role;

-- A creator may submit a generated draft only via an explicit ad INSERT.
-- The trigger verifies the source request belongs to the creator and completed
-- before it stamps provenance. Browser-supplied ai_generated is overwritten.
alter table public.ads
  add column ai_source_request_id uuid references public.ai_image_draft_requests(request_id),
  add column ai_generated boolean not null default false;
create unique index ads_ai_source_request_unique
  on public.ads(ai_source_request_id) where ai_source_request_id is not null;

create function public.set_ad_ai_origin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.ai_source_request_id is null then
    new.ai_generated := false;
  else
    if not exists (select 1 from public.ai_image_draft_requests d
                   where d.request_id=new.ai_source_request_id
                     and d.user_id=new.user_id and d.status='completed') then
      raise exception 'INVALID_AI_DRAFT_SOURCE';
    end if;
    new.ai_generated := true;
  end if;
  return new;
end;
$$;
revoke all on function public.set_ad_ai_origin() from public, anon, authenticated;
create trigger set_ad_ai_origin before insert on public.ads
  for each row execute function public.set_ad_ai_origin();
revoke update (ai_source_request_id,ai_generated) on public.ads from anon,authenticated;

-- Separate fixed-column RPCs preserve the existing public function contracts.
create function public.get_public_ads_with_ai()
returns table(id bigint,user_id uuid,title text,caption text,image_url text,
  support_total numeric,created_at timestamptz,moderation_status text,ai_generated boolean)
language sql stable security definer set search_path = '' as $$
  select a.id,a.user_id,a.title,a.caption,a.image_url,a.support_total,
    a.created_at,a.moderation_status,a.ai_generated
  from public.ads a where a.moderation_status='approved'
  order by a.created_at desc,a.id desc
$$;
create function public.get_my_ads_with_ai()
returns table(id bigint,user_id uuid,title text,caption text,image_url text,
  support_total numeric,created_at timestamptz,moderation_status text,
  duplicate_status text,duplicate_of_ad_id bigint,ai_generated boolean)
language sql stable security definer set search_path = '' as $$
  select a.id,a.user_id,a.title,a.caption,a.image_url,a.support_total,
    a.created_at,a.moderation_status,a.duplicate_status,a.duplicate_of_ad_id,
    a.ai_generated
  from public.ads a where a.user_id=auth.uid()
  order by a.created_at desc,a.id desc
$$;
revoke all on function public.get_public_ads_with_ai(),public.get_my_ads_with_ai()
  from public,anon,authenticated;
grant execute on function public.get_public_ads_with_ai() to anon,authenticated;
grant execute on function public.get_my_ads_with_ai() to authenticated;
commit;

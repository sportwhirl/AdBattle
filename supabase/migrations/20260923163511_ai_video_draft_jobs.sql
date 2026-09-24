-- Staging-only Wan2.1 T2V draft queue. Unapplied; never use in production.
-- No ad or public media is created. The GPU worker runs outside Edge Functions.
create table public.ai_video_draft_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  prompt text not null check (char_length(prompt) between 12 and 600),
  aspect_ratio text not null check (aspect_ratio in ('16:9', '9:16')),
  style text not null default 'freeform_simple'
    check (style in ('pixel_art', 'flat_illustration', 'simple_3d',
      'hand_drawn', 'freeform_simple')),
  model text not null default 'Wan-AI/Wan2.1-T2V-1.3B'
    check (model = 'Wan-AI/Wan2.1-T2V-1.3B'),
  duration text not null default '5s' check (duration = '5s'),
  resolution text not null default '480p' check (resolution = '480p'),
  status text not null default 'pending_review' check (status in (
    'pending_review', 'queued', 'dispatching', 'dispatch_unknown',
    'ready_for_processing', 'failed', 'rejected', 'needs_review'
  )),
  reviewed_at timestamptz,
  reviewed_by text,
  reviewed_request_hash text,
  gpu_task_id text unique,
  original_private_path text,
  original_sha256 text check (original_sha256 ~ '^[0-9a-f]{64}$'),
  full_private_path text,
  full_sha256 text check (full_sha256 ~ '^[0-9a-f]{64}$'),
  hover_private_path text,
  hover_sha256 text check (hover_sha256 ~ '^[0-9a-f]{64}$'),
  poster_private_path text,
  poster_sha256 text check (poster_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_video_draft_request_unique unique (user_id, request_id),
  constraint ai_video_review_bound check (
    reviewed_at is null or
    (reviewed_by is not null and reviewed_request_hash = request_hash)
  ),
  constraint ai_video_approved_required check (
    status in ('pending_review', 'rejected') or reviewed_at is not null
  ),
  constraint ai_video_output_required check (
    status <> 'ready_for_processing' or
    (original_private_path is not null and original_sha256 is not null and full_private_path is not null and
     full_sha256 is not null and poster_private_path is not null and
     poster_sha256 is not null)
  )
);

create function public.enforce_ai_video_draft_insert()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare day_start timestamptz;
begin
  perform pg_advisory_xact_lock(49027, 10);
  new.created_at := now();
  new.updated_at := new.created_at;
  if new.status <> 'pending_review' or new.reviewed_at is not null or
     new.original_sha256 is not null or new.full_private_path is not null or
     new.poster_private_path is not null then
    raise exception 'AI_VIDEO_INVALID_INITIAL_STATE' using errcode = 'P0001';
  end if;
  day_start := ((now() at time zone 'utc')::date)::timestamp at time zone 'utc';
  if (select count(*) from public.ai_video_draft_jobs
      where user_id = new.user_id and created_at >= day_start) >= 1 then
    raise exception 'AI_VIDEO_USER_DAILY_LIMIT' using errcode = 'P0001';
  end if;
  if (select count(*) from public.ai_video_draft_jobs
      where created_at >= day_start) >= 5 then
    raise exception 'AI_VIDEO_GLOBAL_DAILY_LIMIT' using errcode = 'P0001';
  end if;
  return new;
end $$;

create function public.keep_ai_video_draft_request_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.user_id, new.request_id, new.request_hash, new.prompt,
      new.aspect_ratio, new.style, new.model, new.duration, new.resolution, new.created_at)
      is distinct from
     (old.user_id, old.request_id, old.request_hash, old.prompt,
      old.aspect_ratio, old.style, old.model, old.duration, old.resolution, old.created_at) then
    raise exception 'AI_VIDEO_REQUEST_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger ai_video_draft_immutable_request before update on public.ai_video_draft_jobs
for each row execute function public.keep_ai_video_draft_request_immutable();
create trigger ai_video_draft_insert_limit before insert on public.ai_video_draft_jobs
for each row execute function public.enforce_ai_video_draft_insert();

create unique index ai_video_draft_one_active_per_user on public.ai_video_draft_jobs(user_id)
where status in ('pending_review', 'queued', 'dispatching', 'dispatch_unknown', 'needs_review');
create index ai_video_draft_created_at on public.ai_video_draft_jobs(created_at);
create index ai_video_draft_queued on public.ai_video_draft_jobs(created_at)
where status = 'queued';

-- One atomic claim per worker; a crashed worker is never automatically charged twice.
create function public.claim_wan21_video_job()
returns setof public.ai_video_draft_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  return query
  update public.ai_video_draft_jobs j set status = 'dispatching', updated_at = now()
  where j.id = (
    select id from public.ai_video_draft_jobs
    where status = 'queued' and reviewed_request_hash = request_hash
    order by created_at, id for update skip locked limit 1
  ) returning j.*;
end $$;

alter table public.ai_video_draft_jobs enable row level security;
create policy ai_video_draft_owner_read on public.ai_video_draft_jobs
for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.ai_video_draft_jobs from public, anon, authenticated;
grant select (id, request_id, status, aspect_ratio, style, model, duration,
  resolution, error_code, created_at, updated_at)
  on public.ai_video_draft_jobs to authenticated;
grant all on public.ai_video_draft_jobs to service_role;
revoke all on function public.enforce_ai_video_draft_insert() from public, anon, authenticated;
revoke all on function public.keep_ai_video_draft_request_immutable() from public, anon, authenticated;
revoke all on function public.claim_wan21_video_job() from public, anon, authenticated;
grant execute on function public.claim_wan21_video_job() to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai-video-drafts', 'ai-video-drafts', false, 31457280,
        array['video/mp4', 'image/jpeg']);

-- Staging-only AI image posting. The browser can name a completed draft, but
-- only a service-authenticated server can copy its canonical bytes into the
-- pending ad bucket and create a matching AI ad row.
begin;

alter table public.ai_image_draft_requests
  add column post_path text,
  add column post_sha256 text,
  add column post_bytes integer,
  add column post_width integer,
  add column post_height integer,
  add constraint ai_draft_post_derivative_valid check (
    (post_path is null and post_sha256 is null and post_bytes is null
      and post_width is null and post_height is null)
    or
    (post_path = user_id::text || '/' || request_id::text || '.post.jpg'
      and post_sha256 ~ '^[0-9a-f]{64}$'
      and post_bytes between 1 and 512000
      and ((post_width = 640 and post_height = 640)
        or (post_width = 640 and post_height = 360)))
  );

create function public.lock_completed_ai_image_draft()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status='completed' and
     (new.status is distinct from old.status
      or new.output_path is distinct from old.output_path
      or new.output_sha256 is distinct from old.output_sha256
      or new.post_path is distinct from old.post_path
      or new.post_sha256 is distinct from old.post_sha256
      or new.post_bytes is distinct from old.post_bytes
      or new.post_width is distinct from old.post_width
      or new.post_height is distinct from old.post_height) then
    raise exception 'COMPLETED_AI_DRAFT_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function public.lock_completed_ai_image_draft()
  from public,anon,authenticated;
create trigger lock_completed_ai_image_draft
  before update on public.ai_image_draft_requests
  for each row execute function public.lock_completed_ai_image_draft();

alter table public.ads
  add column ai_post_sha256 text,
  add constraint ads_ai_post_sha_valid check
    (ai_post_sha256 is null or ai_post_sha256 ~ '^[0-9a-f]{64}$');

create or replace function public.set_ad_ai_origin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_draft public.ai_image_draft_requests%rowtype;
begin
  if new.ai_source_request_id is null then
    new.ai_generated := false;
    new.ai_post_sha256 := null;
  else
    if (current_setting('request.jwt.claims',true)::jsonb->>'role')
         is distinct from 'service_role' then
      raise exception 'AI_POST_SERVICE_REQUIRED';
    end if;
    select * into v_draft from public.ai_image_draft_requests
      where request_id=new.ai_source_request_id and user_id=new.user_id
        and status='completed' and post_path is not null
        and post_sha256 is not null for share;
    if not found then raise exception 'INVALID_AI_DRAFT_SOURCE'; end if;
    new.ai_generated := true;
    new.ai_post_sha256 := v_draft.post_sha256;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_ad_screening_gate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' then
    if new.user_id is null or new.image_storage_path is null or
       new.image_storage_path !~ ('^' || new.user_id::text ||
         '/[0-9a-f-]{36}\.(jpg|jpeg|png)$') then
      raise exception 'INVALID_PRIVATE_IMAGE_PATH';
    end if;
    if new.ai_source_request_id is not null and
       (current_user <> 'service_role' or
        (current_setting('request.jwt.claims',true)::jsonb->>'role')
          is distinct from 'service_role') then
      raise exception 'AI_POST_SERVICE_REQUIRED';
    end if;
    new.safety_status := 'pending';
    new.duplicate_status := 'pending';
    new.duplicate_of_ad_id := null;
    new.moderation_status := 'pending_scan';
    new.moderation_image_sha256 := null;
    new.image_index_required := false;
    new.image_publication_state := 'pending';
    new.published_image_storage_path := null;
    new.published_image_sha256 := null;
    new.image_url := '';
  else
    if new.ai_source_request_id is distinct from old.ai_source_request_id or
       new.ai_generated is distinct from old.ai_generated or
       new.ai_post_sha256 is distinct from old.ai_post_sha256 then
      raise exception 'AD_AI_ORIGIN_IMMUTABLE';
    end if;
    if new.ai_source_request_id is not null and
       (new.image_publication_state='legacy_public' or
        (new.image_publication_state in ('publishing','public') and
          (new.ai_post_sha256 is null or
           new.moderation_image_sha256 is distinct from new.ai_post_sha256 or
           (new.image_publication_state='public' and
            new.published_image_sha256 is distinct from new.ai_post_sha256)))) then
      raise exception 'AI_CANONICAL_IMAGE_HASH_MISMATCH';
    end if;
    if new.moderation_status='approved' and
        (new.safety_status <> 'passed' or new.duplicate_status <> 'passed' or
         new.image_publication_state not in ('legacy_public','public')) then
      raise exception 'REQUIRED_SCREENING_OR_PUBLICATION_INCOMPLETE';
    end if;
  end if;
  return new;
end;
$$;
revoke update(ai_post_sha256,ai_source_request_id,ai_generated)
  on public.ads from anon,authenticated;

-- Failed publication jobs receive an increasing retry delay, so ten broken
-- objects cannot occupy every slot in each ten-job sweep indefinitely.
alter table public.ad_image_publication_queue
  add column attempts integer not null default 0 check (attempts >= 0),
  add column next_attempt_at timestamptz not null default now(),
  add column last_attempt_at timestamptz;
create index ad_image_publication_eligible_idx
  on public.ad_image_publication_queue(next_attempt_at,created_at);
create function public.defer_ad_image_publication(p_ad_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ad_image_publication_queue set
    attempts=attempts+1,
    last_attempt_at=now(),
    next_attempt_at=now() +
      least(3600,10 * power(2,least(attempts,8))) * interval '1 second'
  where ad_id=p_ad_id;
end;
$$;
revoke all on function public.defer_ad_image_publication(bigint)
  from public,anon,authenticated;
grant execute on function public.defer_ad_image_publication(bigint)
  to service_role;
commit;

-- Deploy after auditing storage policies and handling any pre-existing
-- unapproved public files (see PRIVATE_PENDING_MEDIA.md). No hosted migration
-- was applied while developing this change.
begin;

do $$
begin
  if not exists (select 1 from storage.buckets where id='ad-images' and public) then
    raise exception 'PUBLIC_AD_BUCKET_MUST_EXIST';
  end if;
  if exists (
    select 1 from public.ads
    where moderation_status <> 'approved'
      and image_url like '%/storage/v1/object/public/ad-images/%'
  ) then
    raise exception 'UNREVIEWED_PUBLIC_IMAGES_REQUIRE_MANUAL_CLEANUP';
  end if;
  if exists (
    select 1 from storage.objects o where o.bucket_id='ad-images'
      and not exists (
        select 1 from public.ads a where a.moderation_status='approved'
          and (a.image_storage_path=o.name or
            right(a.image_url,length('/storage/v1/object/public/ad-images/'||o.name))
              = '/storage/v1/object/public/ad-images/'||o.name)
      )
  ) then
    raise exception 'UNREFERENCED_PUBLIC_IMAGES_REQUIRE_MANUAL_CLEANUP';
  end if;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('ad-pending-images','ad-pending-images',false,10485760,
        array['image/jpeg','image/png'])
on conflict (id) do nothing;
do $$
begin
  if exists (select 1 from storage.buckets where id='ad-pending-images'
      and (public is distinct from false or file_size_limit is distinct from 10485760
           or allowed_mime_types is distinct from array['image/jpeg','image/png'])) then
    raise exception 'PENDING_AD_BUCKET_MISCONFIGURED';
  end if;
end $$;

-- Restrictive policies are ANDed with every other policy. They block older,
-- broader INSERT/UPDATE/DELETE grants on this public bucket as well as copy,
-- move and upsert through the Storage API. Service role bypasses RLS.
create policy ad_public_service_only_insert on storage.objects as restrictive
  for insert to public with check (bucket_id <> 'ad-images'
    and (bucket_id <> 'ad-pending-images' or
      ((storage.foldername(name))[1] = (select auth.uid())::text
       and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png)$')));
create policy ad_public_service_only_update on storage.objects as restrictive
  for update to public using (bucket_id not in ('ad-images','ad-pending-images'))
  with check (bucket_id not in ('ad-images','ad-pending-images'));
create policy ad_public_service_only_delete on storage.objects as restrictive
  for delete to public using (bucket_id not in ('ad-images','ad-pending-images'));
create policy ad_private_owner_only_read on storage.objects as restrictive
  for select to public using (bucket_id <> 'ad-pending-images' or
    (storage.foldername(name))[1] = (select auth.uid())::text);
create policy ad_private_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ad-pending-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png)$');
create policy ad_private_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'ad-pending-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text);
-- No browser UPDATE or DELETE grant is added to the private bucket.

alter table public.ads
  add column image_publication_state text not null default 'pending',
  add column published_image_storage_path text,
  add column published_image_sha256 text;
alter table public.ads
  add constraint ads_image_publication_state_valid check
    (image_publication_state in ('pending','publishing','public','legacy_public')),
  add constraint ads_published_sha_valid check
    (published_image_sha256 is null or published_image_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint ads_published_object_required check
    (image_publication_state <> 'public' or
     (published_image_storage_path is not null and published_image_sha256 is not null
      and image_url <> ''));

-- Approved legacy objects remain public with their original URLs. Any other
-- historic nonpublic URL is removed from the owner RPC immediately.
update public.ads set image_publication_state='legacy_public'
  where moderation_status='approved';
update public.ads set image_url='' where moderation_status<>'approved';

-- Browser INSERT privilege on ads is table-wide. All pipeline fields are
-- server-stamped regardless of caller-supplied values. No AI source is accepted
-- until the posted derivative can be bound to its private generated draft.
create or replace function public.enforce_ad_screening_gate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' then
    if new.user_id is null or new.image_storage_path is null or
       new.image_storage_path !~ ('^' || new.user_id::text ||
         '/[0-9a-f-]{36}\.(jpg|jpeg|png)$') then
      raise exception 'INVALID_PRIVATE_IMAGE_PATH';
    end if;
    if new.ai_source_request_id is not null then
      raise exception 'AI_POST_ORIGIN_UNVERIFIED';
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
  elsif new.moderation_status='approved' and
        (new.safety_status <> 'passed' or new.duplicate_status <> 'passed' or
         new.image_publication_state not in ('legacy_public','public')) then
    raise exception 'REQUIRED_SCREENING_OR_PUBLICATION_INCOMPLETE';
  end if;
  return new;
end;
$$;

create or replace function public.refresh_ad_moderation_status(p_ad_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ads set
    moderation_status = case
      when moderation_status='removed' then 'removed'
      when safety_status='failed' or duplicate_status='rejected' then 'rejected'
      when safety_status='passed' and duplicate_status='passed'
        and image_publication_state in ('public','legacy_public') then 'approved'
      else 'pending_scan' end,
    moderated_at = case when safety_status='passed' and duplicate_status='passed'
      and image_publication_state in ('public','legacy_public') then now()
      else moderated_at end
  where id=p_ad_id;
end;
$$;

-- Whichever scan finishes second creates exactly one durable publication job.
-- A Database Webhook on this queue can run the worker immediately; a periodic
-- secret-authenticated sweep retries transient Storage/API failures.
create table public.ad_image_publication_queue (
  ad_id bigint primary key references public.ads(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.ad_image_publication_queue enable row level security;
revoke all on public.ad_image_publication_queue from public,anon,authenticated;
grant select,insert,delete on public.ad_image_publication_queue to service_role;
create function public.enqueue_ad_image_publication()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.safety_status='passed' and new.duplicate_status='passed'
    and new.image_publication_state='pending' then
    insert into public.ad_image_publication_queue(ad_id) values(new.id)
      on conflict (ad_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.enqueue_ad_image_publication()
  from public,anon,authenticated;
create trigger enqueue_ad_image_publication
  after update of safety_status,duplicate_status on public.ads
  for each row execute function public.enqueue_ad_image_publication();
insert into public.ad_image_publication_queue(ad_id)
  select id from public.ads where safety_status='passed'
    and duplicate_status='passed' and image_publication_state='pending'
  on conflict do nothing;

create function public.claim_ad_image_publication(p_ad_id bigint)
returns table(public_path text, expected_sha256 text)
language plpgsql security definer set search_path = '' as $$
declare v_ad public.ads%rowtype; v_duplicate_sha text;
begin
  select * into v_ad from public.ads where id=p_ad_id for update;
  if not found or v_ad.image_publication_state not in ('pending','publishing')
     or v_ad.moderation_status <> 'pending_scan'
     or v_ad.safety_status <> 'passed' or v_ad.duplicate_status <> 'passed'
     or v_ad.image_storage_path is null or v_ad.user_id is null then
    raise exception 'IMAGE_NOT_READY_TO_PUBLISH';
  end if;
  select encode(f.sha256,'hex') into v_duplicate_sha
    from public.ad_image_fingerprints f where f.ad_id=p_ad_id;
  if v_duplicate_sha is null or v_ad.moderation_image_sha256 is null
     or v_duplicate_sha <> v_ad.moderation_image_sha256
     or v_ad.moderation_image_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'IMAGE_SCAN_HASH_MISMATCH';
  end if;
  update public.ads set image_publication_state='publishing'
    where id=p_ad_id and image_publication_state='pending';
  public_path := v_ad.user_id::text || '/' || p_ad_id::text || '-' || v_duplicate_sha;
  expected_sha256 := v_duplicate_sha;
  return next;
end;
$$;

create function public.complete_ad_image_publication(
  p_ad_id bigint,p_sha256 text,p_public_path text,p_public_url text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_ad public.ads%rowtype; v_duplicate_sha text; v_path text;
begin
  select * into v_ad from public.ads where id=p_ad_id for update;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  if v_ad.image_publication_state='public' and v_ad.published_image_sha256=p_sha256
     and v_ad.published_image_storage_path=p_public_path and v_ad.image_url=p_public_url then
    return 'already_public';
  end if;
  select encode(f.sha256,'hex') into v_duplicate_sha
    from public.ad_image_fingerprints f where f.ad_id=p_ad_id;
  v_path := v_ad.user_id::text || '/' || p_ad_id::text || '-' || p_sha256;
  if v_ad.image_publication_state <> 'publishing'
     or v_ad.moderation_status <> 'pending_scan'
     or v_ad.safety_status <> 'passed' or v_ad.duplicate_status <> 'passed'
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or v_duplicate_sha <> p_sha256 or v_ad.moderation_image_sha256 <> p_sha256
     or p_public_path <> v_path
     or p_public_url is null or p_public_url not like 'https://%'
     or right(p_public_url,length('/storage/v1/object/public/ad-images/'||p_public_path))
          <> '/storage/v1/object/public/ad-images/'||p_public_path then
    raise exception 'IMAGE_PUBLICATION_VERIFICATION_FAILED';
  end if;
  update public.ads set image_publication_state='public',
    published_image_storage_path=p_public_path,published_image_sha256=p_sha256,
    image_url=p_public_url,moderation_status='approved',moderated_at=now()
    where id=p_ad_id;
  return 'approved';
end;
$$;

revoke all on function public.claim_ad_image_publication(bigint),
  public.complete_ad_image_publication(bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.claim_ad_image_publication(bigint),
  public.complete_ad_image_publication(bigint,text,text,text)
  to service_role;
revoke update(image_url,image_storage_path,image_publication_state,
  published_image_storage_path,published_image_sha256,moderation_image_sha256,
  image_index_required) on public.ads from anon,authenticated;

commit;

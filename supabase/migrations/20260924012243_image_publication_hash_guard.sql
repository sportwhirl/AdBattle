-- A missing fingerprint or moderation hash must never satisfy a SQL IF guard:
-- ordinary <> comparisons return NULL when either side is NULL.
begin;

create or replace function public.complete_ad_image_publication(
  p_ad_id bigint,p_sha256 text,p_public_path text,p_public_url text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_ad public.ads%rowtype; v_duplicate_sha text; v_path text;
begin
  select * into v_ad from public.ads where id=p_ad_id for update;
  if not found then raise exception 'AD_NOT_FOUND'; end if;

  select encode(f.sha256,'hex') into v_duplicate_sha
    from public.ad_image_fingerprints f where f.ad_id=p_ad_id;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or v_duplicate_sha is distinct from p_sha256
     or v_ad.moderation_image_sha256 is distinct from p_sha256 then
    raise exception 'IMAGE_PUBLICATION_VERIFICATION_FAILED';
  end if;

  -- Check the authoritative hashes even when retrying an approved call.
  if v_ad.image_publication_state='public' and v_ad.published_image_sha256=p_sha256
     and v_ad.published_image_storage_path=p_public_path and v_ad.image_url=p_public_url then
    return 'already_public';
  end if;
  v_path := v_ad.user_id::text || '/' || p_ad_id::text || '-' || p_sha256;
  if v_ad.image_publication_state <> 'publishing'
     or v_ad.moderation_status <> 'pending_scan'
     or v_ad.safety_status <> 'passed' or v_ad.duplicate_status <> 'passed'
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

revoke all on function public.complete_ad_image_publication(bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.complete_ad_image_publication(bigint,text,text,text)
  to service_role;

commit;

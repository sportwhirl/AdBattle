-- Review modest crops without weakening the existing exact/whole-image checks.
-- New submissions fail closed until all existing indexed bytes have v2 regions.
-- Historical moderation decisions, publications, and wallet data are untouched.
begin;
create schema if not exists duplicate_private;
revoke all on schema duplicate_private from public,anon,authenticated,service_role;

create function duplicate_private.valid_crop_fingerprint(p jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare r jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object'
     or p->>'version' is distinct from 'crop-grid-49-rgb-dhash128-v1'
     or jsonb_typeof(p->'width') is distinct from 'number'
     or jsonb_typeof(p->'height') is distinct from 'number'
     or coalesce(p->>'width','') !~ '^[1-9][0-9]{0,3}$'
     or coalesce(p->>'height','') !~ '^[1-9][0-9]{0,3}$'
     or jsonb_typeof(p->'regions') is distinct from 'array' then return false; end if;
  if (p->>'width')::integer>4096 or (p->>'height')::integer>4096
     or jsonb_array_length(p->'regions')<>49 then return false; end if;
  for r in select value from jsonb_array_elements(p->'regions') loop
    if jsonb_typeof(r) is distinct from 'object'
       or coalesce(r->>'hash','') !~ '^[0-9a-f]{32}$'
       or jsonb_typeof(r->'hash') is distinct from 'string'
       or coalesce(r->>'color','') !~ '^[0-9a-f]{54}$'
       or jsonb_typeof(r->'color') is distinct from 'string'
       or jsonb_typeof(r->'contrast') is distinct from 'number'
       or coalesce(r->>'contrast','') !~ '^(0|[1-9][0-9]{0,2})$' then return false; end if;
    if (r->>'contrast')::integer>127 then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function duplicate_private.valid_crop_fingerprint(jsonb) from public,anon,authenticated,service_role;
alter table public.ad_image_fingerprints add column crop_fingerprint jsonb
  check (crop_fingerprint is null or duplicate_private.valid_crop_fingerprint(crop_fingerprint));
create index ad_image_crop_missing_idx on public.ad_image_fingerprints(ad_id)
  where crop_fingerprint is null;

-- At most 97 full-to-region comparisons per candidate. No crop-to-crop matches.
-- Hash <=8/128, color mean absolute error <=8/255, aspect difference <=5%,
-- contrast >=18, and at least 16 of each bit value. Only a review signal.
create function duplicate_private.crop_match(a jsonb,b jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare pair record; x jsonb; y jsonb; h1 bit(128); h2 bit(128); d integer;
  color_error integer; c1 bytea; c2 bytea; best jsonb; best_distance integer:=129;
begin
  if a is null or b is null then return null; end if;
  for pair in
    with geometry as (
      select row_number() over(order by wi,hi,xi,yi)-1 slot,w,h
      from unnest(array[1.0,0.9,0.8]) with ordinality ws(w,wi)
      cross join unnest(array[1.0,0.9,0.8]) with ordinality hs(h,hi)
      cross join lateral generate_series(0,case when w=1 then 0 else 2 end) xs(xi)
      cross join lateral generate_series(0,case when h=1 then 0 else 2 end) ys(yi)
    )
    select 0 ai,slot::integer bi,1.0 aw,1.0 ah,w bw,h bh from geometry
    union all
    select slot::integer,0,w,h,1.0,1.0 from geometry where slot<>0
  loop
    if abs(ln(((a->>'width')::numeric*pair.aw/((a->>'height')::numeric*pair.ah)) /
              ((b->>'width')::numeric*pair.bw/((b->>'height')::numeric*pair.bh))))>ln(1.05) then continue; end if;
    x:=a->'regions'->pair.ai; y:=b->'regions'->pair.bi;
    if (x->>'contrast')::integer<18 or (y->>'contrast')::integer<18 then continue; end if;
    h1:=('x'||(x->>'hash'))::bit(128); h2:=('x'||(y->>'hash'))::bit(128);
    if bit_count(h1) not between 16 and 112 or bit_count(h2) not between 16 and 112 then continue; end if;
    d:=bit_count(h1 # h2)::integer;
    if d>8 or d>=best_distance then continue; end if;
    c1:=decode(x->>'color','hex'); c2:=decode(y->>'color','hex');
    select sum(abs(get_byte(c1,i)-get_byte(c2,i)))::integer into color_error from generate_series(0,26) s(i);
    if color_error>216 then continue; end if;
    best_distance:=d;
    best:=jsonb_build_object('version',a->>'version','distance',d,
      'submitted_region',pair.ai,'matched_region',pair.bi,'color_error_sum',color_error);
  end loop;
  return best;
end;
$$;
revoke all on function duplicate_private.crop_match(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Backfill the same bytes already fingerprinted. Replays cannot replace a
-- descriptor, resurrect a rejected ad, or enqueue publication.
create function public.record_ad_crop_fingerprint(p_ad_id bigint,p_sha256_hex text,p_crop_fingerprint jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.ad_image_fingerprints%rowtype;
begin
  if p_sha256_hex is null or p_sha256_hex !~ '^[0-9a-f]{64}$'
     or not duplicate_private.valid_crop_fingerprint(p_crop_fingerprint) then raise exception 'INVALID_FINGERPRINT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ad-image-scan-v1',0));
  select * into f from public.ad_image_fingerprints where ad_id=p_ad_id for update;
  if not found then raise exception 'EXISTING_FINGERPRINT_REQUIRED'; end if;
  if f.sha256<>decode(p_sha256_hex,'hex') then raise exception 'INDEXED_IMAGE_BYTES_CHANGED'; end if;
  if f.crop_fingerprint is not null and f.crop_fingerprint<>p_crop_fingerprint then
    raise exception 'CROP_FINGERPRINT_IMMUTABLE'; end if;
  update public.ad_image_fingerprints set crop_fingerprint=p_crop_fingerprint
    where ad_id=p_ad_id and crop_fingerprint is null;
  return jsonb_build_object('status','crop_indexed','ad_id',p_ad_id);
end;
$$;
revoke all on function public.record_ad_crop_fingerprint(bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_ad_crop_fingerprint(bigint,text,jsonb) to service_role;

-- Retire the old scan entry point rather than leave a service-role bypass.
create or replace function public.record_ad_duplicate_scan(
  p_ad_id bigint,p_sha256_hex text,p_visual_hash_hex text,p_visual_hash_version text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.ads%rowtype;
begin
  select * into target from public.ads where id=p_ad_id;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  if target.duplicate_status='pending' then raise exception 'CROP_SCANNER_UPGRADE_REQUIRED'; end if;
  return jsonb_build_object('status',target.duplicate_status,'matched_ad_id',target.duplicate_of_ad_id);
end;
$$;
create or replace function public.record_ad_duplicate_scan_v2(
  p_ad_id bigint, p_sha256_hex text, p_visual_hash_hex text, p_visual_hash_version text, p_crop_fingerprint jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target public.ads%rowtype;
  exact_match record;
  visual_match record;
  result_status text;
  matched_id bigint;
  distance integer;
  crop_match jsonb;
  match_method text;
begin
  if p_sha256_hex is null or p_visual_hash_hex is null or p_visual_hash_version is null
     or not duplicate_private.valid_crop_fingerprint(p_crop_fingerprint)
     or p_sha256_hex !~ '^[0-9a-f]{64}$' or p_visual_hash_hex !~ '^[0-9a-f]{16}$'
     or p_visual_hash_version <> 'dhash-9x8-luma-v1' then
    raise exception 'INVALID_FINGERPRINT';
  end if;
  -- Take the shared index lock before any ad row lock, matching backfill.
  perform pg_advisory_xact_lock(hashtextextended('ad-image-scan-v1', 0));
  select * into target from public.ads where id = p_ad_id for update;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  if target.duplicate_status <> 'pending' then
    return jsonb_build_object('status', target.duplicate_status, 'matched_ad_id', target.duplicate_of_ad_id);
  end if;
  if not coalesce((select ready from public.ad_image_index_state where singleton),false)
     or exists(select 1 from public.ad_image_fingerprints where crop_fingerprint is null) then
    raise exception 'CROP_INDEX_BACKFILL_INCOMPLETE';
  end if;

  select a.id, a.user_id into exact_match
    from public.ad_image_fingerprints f join public.ads a on a.id = f.ad_id
    where f.sha256 = decode(p_sha256_hex, 'hex') and a.id <> p_ad_id
    order by a.created_at, a.id limit 1;
  if found then
    matched_id := exact_match.id;
    result_status := case when exact_match.user_id = target.user_id
      then 'duplicate_same_creator' else 'review_identical' end;
    distance := 0; match_method := 'exact';
  else
    select a.id, bit_count(f.visual_hash # (('x' || p_visual_hash_hex)::bit(64)))::integer as d
      into visual_match
      from public.ad_image_fingerprints f join public.ads a on a.id = f.ad_id
      where f.visual_hash_version = p_visual_hash_version and a.id <> p_ad_id
        and bit_count(f.visual_hash # (('x' || p_visual_hash_hex)::bit(64))) <= 8
      order by d, a.created_at, a.id limit 1;
    if found then
      result_status := 'review_similar'; matched_id := visual_match.id; distance := visual_match.d;
      match_method := 'whole_dhash';
    else
      with candidates as materialized (
        select a.id,a.created_at,
          duplicate_private.crop_match(p_crop_fingerprint,f.crop_fingerprint) evidence
        from public.ad_image_fingerprints f join public.ads a on a.id=f.ad_id
        where a.id<>p_ad_id
      )
      select id,evidence into visual_match from candidates where evidence is not null
        order by (evidence->>'distance')::integer,created_at,id limit 1;
      if found then
        result_status := 'review_similar'; matched_id := visual_match.id;
        crop_match := visual_match.evidence; match_method := 'crop_region';
      else
        result_status := 'passed';
      end if;
    end if;
  end if;

  insert into public.ad_image_fingerprints(ad_id,sha256,visual_hash,visual_hash_version,crop_fingerprint)
    values (p_ad_id,decode(p_sha256_hex,'hex'),(('x'||p_visual_hash_hex)::bit(64)),p_visual_hash_version,p_crop_fingerprint);
  update public.ads set duplicate_status=result_status, duplicate_of_ad_id=matched_id,
    moderation_details=coalesce(moderation_details,'{}'::jsonb) || jsonb_build_object(
      'duplicate_check',jsonb_build_object('status',result_status,'matched_ad_id',matched_id,
        'visual_distance',distance,'hash_version',p_visual_hash_version,'match_method',match_method,'crop_match',crop_match))
    where id=p_ad_id;
  insert into public.ad_scan_attempts(ad_id,outcome,details) values
    (p_ad_id,'completed',jsonb_build_object('status',result_status,'matched_ad_id',matched_id,'visual_distance',distance,'match_method',match_method,'crop_match',crop_match));
  perform public.refresh_ad_moderation_status(p_ad_id);
  return jsonb_build_object('status',result_status,'matched_ad_id',matched_id,'visual_distance',distance,'match_method',match_method,'crop_match',crop_match);
end;
$$;

revoke all on function public.record_ad_duplicate_scan_v2(bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_ad_duplicate_scan_v2(bigint,text,text,text,jsonb) to service_role;
commit;

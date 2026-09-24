-- Keep the existing descriptor format and strict crop rule. Crops between
-- sampled sizes can differ by 9-14 bits; review those only with stronger color
-- corroboration (mean RGB error <=5/255, every value <=24/255) and a real region.
-- The aspect, contrast and bit-diversity gates apply to both rules. No broader
-- whole-to-whole or region-to-region comparison, rescan, or publication change.
-- No descriptor backfill or Edge Function redeploy is needed after PR23 rollout.
begin;
create or replace function duplicate_private.crop_match(a jsonb,b jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare pair record; x jsonb; y jsonb; h1 bit(128); h2 bit(128); d integer;
  color_error integer; color_max integer; match_rule text; c1 bytea; c2 bytea; best jsonb; best_distance integer:=129;
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
    if d>14 or d>=best_distance then continue; end if;
    c1:=decode(x->>'color','hex'); c2:=decode(y->>'color','hex');
    select sum(abs(get_byte(c1,i)-get_byte(c2,i)))::integer,
           max(abs(get_byte(c1,i)-get_byte(c2,i)))::integer
      into color_error,color_max from generate_series(0,26) s(i);
    if d<=8 and color_error<=216 then
      match_rule:='strict';
    elsif d between 9 and 14 and (pair.ai<>0 or pair.bi<>0)
          and color_error<=135 and color_max<=24 then
      match_rule:='color_supported';
    else
      continue;
    end if;
    best_distance:=d;
    best:=jsonb_build_object('version',a->>'version','distance',d,
      'submitted_region',pair.ai,'matched_region',pair.bi,'color_error_sum',color_error,
      'color_error_max',color_max,'match_rule',match_rule,'matcher_version','crop-review-v2');
  end loop;
  return best;
end;
$$;
revoke all on function duplicate_private.crop_match(jsonb,jsonb) from public,anon,authenticated,service_role;

commit;

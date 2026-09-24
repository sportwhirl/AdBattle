import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test,{before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {cropFingerprint} from '../supabase/functions/_shared/crop-fingerprint.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const fixtures=JSON.parse(read('tests/fixtures/crop_parrot_fingerprints.json'));
const original=fixtures.original.fingerprint, crop=fixtures.crop.fingerprint;
const migration=read('supabase/migrations/20260924013032_cropped_image_review.sql');
const colorMigration=read('supabase/migrations/20260924022837_crop_color_supported_review.sql');
const offGrid=fixtures.off_grid_crop.fingerprint;
const unrelated=JSON.parse(read('tests/fixtures/crop_unrelated_fingerprints.json')).images;
const alice='00000000-0000-4000-8000-000000000001',bob='00000000-0000-4000-8000-000000000002';
let db,legacy;
async function ad(owner,title) {return (await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
 values($1::uuid,$2,'',$1::uuid::text||'/00000000-0000-4000-8000-'||lpad((select coalesce(max(id),0)+1 from ads)::text,12,'0')||'.jpg') returning id`,[owner,title])).rows[0].id;}
async function scan(id,sha,hash,fp) {return (await db.query('select record_ad_duplicate_scan_v2($1,$2,$3,$4,$5) r',[id,sha,hash,'dhash-9x8-luma-v1',fp])).rows[0].r;}
async function backfill(id,sha,fp) {return db.query('select record_ad_crop_fingerprint($1,$2,$3) r',[id,sha,fp]);}
async function match(a,b){return (await db.query('select duplicate_private.crop_match($1,$2) r',[a,b])).rows[0].r;}
before(async()=>{
 db=new PGlite();
 await db.exec(`create schema auth; create schema storage; create table auth.users(id uuid primary key);
 create role anon; create role authenticated; create role service_role;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function storage.foldername(name text) returns text[] language sql immutable as $$select string_to_array(regexp_replace(name,'/[^/]*$',''),'/')$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,primary key(bucket_id,name)); alter table storage.objects enable row level security;
 grant usage on schema public,auth,storage to anon,authenticated,service_role;
 insert into storage.buckets(id,name,public) values('ad-images','ad-images',true);`);
 await db.exec(read('supabase/staging/00_test_base.sql'));
 await db.query('insert into auth.users values($1),($2)',[alice,bob]);
 legacy=(await db.query(`insert into ads(user_id,title,image_url,moderation_status)
 values($1,'Original parrot','https://test.invalid/parrot.jpg','approved') returning id`,[alice])).rows[0].id;
 await db.exec(read('supabase/migrations/20260922_duplicate_screening.sql'));
 await db.query("update ads set image_storage_path=user_id||'/parrot.jpg' where id=$1",[legacy]);
 await db.exec(read('supabase/migrations/20260923162944_ai_image_draft_quota.sql'));
 await db.exec(read('supabase/migrations/20260923170000_private_pending_images.sql'));
 await db.exec(read('supabase/migrations/20260924012243_image_publication_hash_guard.sql'));
 await db.query('select record_ad_legacy_fingerprint($1,$2,$3,$4)',[legacy,fixtures.original.sha256,fixtures.original.dhash,'dhash-9x8-luma-v1']);
 await db.query("select complete_ad_image_index_backfill('All old sources are indexed','test-operator')");
 await db.exec(migration);
 // Reproduce the actual browser miss before applying the follow-up migration.
 assert.equal(await match(offGrid,original),null);
 const snapshot=async()=> (await db.query(`select jsonb_build_object(
   'ads',(select jsonb_agg(to_jsonb(a) order by id) from ads a),
   'fingerprints',(select jsonb_agg(to_jsonb(f) order by ad_id) from ad_image_fingerprints f),
   'attempts',(select jsonb_agg(to_jsonb(s) order by id) from ad_scan_attempts s),
   'publication',(select jsonb_agg(to_jsonb(q) order by ad_id) from ad_image_publication_queue q),
   'rpc',pg_get_functiondef('record_ad_duplicate_scan_v2(bigint,text,text,text,jsonb)'::regprocedure),
   'acl',(select proacl::text from pg_proc where oid='duplicate_private.crop_match(jsonb,jsonb)'::regprocedure)
 ) r`)).rows[0].r;
 const beforeMigration=await snapshot();
 await db.exec(colorMigration);
 assert.deepEqual(await snapshot(),beforeMigration);
});
after(async()=>db?.close());

test('actual staging crop is detected in either order without loosening old dHash',async()=>{
 const oldDistance=[...(BigInt('0x'+fixtures.original.dhash)^BigInt('0x'+fixtures.crop.dhash)).toString(2)].filter(x=>x==='1').length;
 assert.equal(oldDistance,27);
 const result=await match(crop,original);
 assert.equal(result.distance,8); assert.equal(result.submitted_region,0); assert.equal(result.matched_region,12);
 assert.equal((await match(original,crop)).distance,8);
});

test('browser crop test matches the original alone in both upload orders',async()=>{
 const oldDistance=[...(BigInt('0x'+fixtures.original.dhash)^BigInt('0x'+fixtures.off_grid_crop.dhash)).toString(2)].filter(x=>x==='1').length;
 assert.equal(oldDistance,26);
 const result=await match(offGrid,original);
 assert.deepEqual(result,{
  version:'crop-grid-49-rgb-dhash128-v1',matcher_version:'crop-review-v2',match_rule:'color_supported',
  distance:13,submitted_region:0,matched_region:42,color_error_sum:110,color_error_max:16,
 });
 const reverse=await match(original,offGrid);
 assert.equal(reverse.distance,13);assert.equal(reverse.submitted_region,42);assert.equal(reverse.matched_region,0);
 assert.equal((await match(crop,original)).match_rule,'strict');
});

test('broader crop distance needs tight colors and cannot broaden whole-image matching',async()=>{
 function pair(distance,colorDiffs,regional=true){
  const a=structuredClone(original),b=structuredClone(original);
  for(const fp of [a,b])for(const r of fp.regions)r.contrast=0;
  const base={hash:'55'.repeat(16),color:'64'.repeat(27),contrast:40};
  a.regions[0]={...base};
  b.regions[regional?42:0]={...base,
   hash:(BigInt('0x'+base.hash)^((1n<<BigInt(distance))-1n)).toString(16).padStart(32,'0'),
   color:Array.from({length:27},(_,i)=>(100+(colorDiffs[i]||0)).toString(16).padStart(2,'0')).join(''),
  };
  return [a,b];
 }
 assert.equal((await match(...pair(14,Array(27).fill(5)))).match_rule,'color_supported');
 assert.equal(await match(...pair(15,Array(27).fill(5))),null);
 assert.equal(await match(...pair(14,[6,...Array(26).fill(5)])),null);
 assert.equal(await match(...pair(9,[25])),null);
 assert.equal((await match(...pair(9,[24]))).match_rule,'color_supported');
 assert.equal(await match(...pair(9,[],false)),null);
 // The original strict rule retains its original color allowance.
 assert.equal((await match(...pair(8,Array(27).fill(8),false))).match_rule,'strict');
 assert.equal(await match(...pair(8,[9,...Array(26).fill(8)],false)),null);
 // Existing gates also apply to the new color-supported branch.
 const [a,b]=pair(13,[]);
 assert.equal(await match({...a,width:4000,height:100},b),null);
 const lowContrast=structuredClone(b);lowContrast.regions[42].contrast=17;
 assert.equal(await match(a,lowContrast),null);
 const lowDiversity=pair(13,[]);lowDiversity[0].regions[0].hash='0'.repeat(32);
 lowDiversity[1].regions[42].hash='0'.repeat(28)+'1fff';
 assert.equal(await match(...lowDiversity),null);
});

test('actual unrelated staging creatives do not become parrot crop matches',async()=>{
 for(const image of unrelated)for(const parrot of [original,crop,offGrid]){
  assert.equal(await match(image.fingerprint,parrot),null);
  assert.equal(await match(parrot,image.fingerprint),null);
 }
});

test('color, contrast, bit diversity and aspect checks reject lookalike signatures',async()=>{
 const changedColor=structuredClone(crop);for(const r of changedColor.regions)r.color='00'.repeat(27);
 assert.equal(await match(changedColor,original),null);
 const blank=structuredClone(original);for(const r of blank.regions)r.contrast=0;
 assert.equal(await match(blank,original),null);
 const flat=structuredClone(original);for(const r of flat.regions)r.hash='0'.repeat(32);
 assert.equal(await match(flat,flat),null);
 assert.equal(await match({...original,width:4000,height:100},original),null);
 const different=structuredClone(original);for(const r of different.regions)r.hash=(BigInt('0x'+r.hash)^((1n<<128n)-1n)).toString(16).padStart(32,'0');
 assert.equal(await match(different,original),null);
 // Partial shared regions alone cannot trigger a match.
 const a=structuredClone(flat),b=structuredClone(flat);a.regions[12]=original.regions[12];b.regions[12]=original.regions[12];
 assert.equal(await match(a,b),null);
});

test('unrelated textured RGB fixtures are not new crop matches',async()=>{
 const fingerprints=[];
 for(let seed=1;seed<=6;seed++){
  let state=seed;const pixels=Array.from({length:16*16},()=>Array.from({length:3},()=>{
   state=(Math.imul(state,1664525)+1013904223)>>>0;return state>>>24;
  }));
  fingerprints.push(cropFingerprint({width:240,height:240,getRGBAAt(x,y){
   return [...pixels[Math.floor((y-1)/15)*16+Math.floor((x-1)/15)],255];
  }}));
 }
 for(let i=0;i<fingerprints.length;i++)for(let j=i+1;j<fingerprints.length;j++){
  assert.equal(await match(fingerprints[i],fingerprints[j]),null,`unrelated ${i}/${j}`);
 }
});

test('incomplete backfill and old scanner cannot publish a new ad',async()=>{
 const id=await ad(bob,'blocked before backfill');
 await db.query("select record_ad_safety_scan($1,'passed',null)",[id]);
 await assert.rejects(scan(id,fixtures.crop.sha256,fixtures.crop.dhash,crop),/CROP_INDEX_BACKFILL_INCOMPLETE/);
 await assert.rejects(db.query('select record_ad_duplicate_scan($1,$2,$3,$4)',[id,fixtures.crop.sha256,fixtures.crop.dhash,'dhash-9x8-luma-v1']),/CROP_SCANNER_UPGRADE_REQUIRED/);
 assert.equal((await db.query('select duplicate_status from ads where id=$1',[id])).rows[0].duplicate_status,'pending');
 assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[id])).rows[0].n,0);
 await assert.rejects(backfill(legacy,'00'.repeat(32),original),/INDEXED_IMAGE_BYTES_CHANGED/);
 const before=(await db.query('select to_jsonb(a) r from ads a where id=$1',[legacy])).rows[0].r;
 await backfill(legacy,fixtures.original.sha256,original);await backfill(legacy,fixtures.original.sha256,original);
 assert.deepEqual((await db.query('select to_jsonb(a) r from ads a where id=$1',[legacy])).rows[0].r,before);
 await assert.rejects(backfill(legacy,fixtures.original.sha256,crop),/CROP_FINGERPRINT_IMMUTABLE/);
 const offGridId=await ad(bob,'crop test regression');
 await db.query('update ads set moderation_image_sha256=$2 where id=$1',[offGridId,fixtures.off_grid_crop.sha256]);
 await db.query("select record_ad_safety_scan($1,'passed',null)",[offGridId]);
 const offGridResult=await scan(offGridId,fixtures.off_grid_crop.sha256,fixtures.off_grid_crop.dhash,offGrid);
 assert.equal(offGridResult.status,'review_similar');assert.equal(offGridResult.matched_ad_id,legacy);
 assert.equal(offGridResult.crop_match.match_rule,'color_supported');
 assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[offGridId])).rows[0].n,0);
 assert.equal((await db.query('select details from ad_scan_attempts where ad_id=$1',[offGridId])).rows[0].details.crop_match.match_rule,'color_supported');
 // Retrying a completed scan cannot add evidence rows or bypass the review hold.
 assert.equal((await scan(offGridId,fixtures.off_grid_crop.sha256,fixtures.off_grid_crop.dhash,offGrid)).status,'review_similar');
 assert.equal((await db.query('select count(*)::int n from ad_scan_attempts where ad_id=$1',[offGridId])).rows[0].n,1);
 const result=await scan(id,fixtures.crop.sha256,fixtures.crop.dhash,crop);
 assert.equal(result.status,'review_similar');assert.equal(result.match_method,'crop_region');assert.equal(result.matched_ad_id,legacy);
 assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[id])).rows[0].n,0);
 await db.query("select resolve_ad_duplicate_review($1,'reject','test-moderator','Cropped duplicate regression review')",[id]);
 const rejected=(await db.query('select to_jsonb(a) r from ads a where id=$1',[id])).rows[0].r;
 await backfill(id,fixtures.crop.sha256,crop);
 assert.equal((await scan(id,fixtures.crop.sha256,fixtures.crop.dhash,crop)).status,'rejected');
 assert.deepEqual((await db.query('select to_jsonb(a) r from ads a where id=$1',[id])).rows[0].r,rejected);
 assert.equal((await db.query('select count(*)::int n from ad_duplicate_review_decisions where ad_id=$1',[id])).rows[0].n,1);
});

test('exact and v1 visual behavior still take priority',async()=>{
 const own=await ad(alice,'identical same owner');assert.equal((await scan(own,fixtures.original.sha256,fixtures.original.dhash,original)).status,'duplicate_same_creator');
 const other=await ad(bob,'identical other owner');assert.equal((await scan(other,fixtures.original.sha256,fixtures.original.dhash,original)).status,'review_identical');
 const visual=await ad(bob,'whole resize');const r=await scan(visual,'12'.repeat(32),fixtures.original.dhash,original);
 assert.equal(r.match_method,'whole_dhash');assert.equal(r.status,'review_similar');
});

test('unrelated fingerprint may pass and publication still needs safety and byte verification',async()=>{
 const fp=structuredClone(original);for(const r of fp.regions)r.color='ff'.repeat(27);
 const id=await ad(bob,'different image');
 const result=await scan(id,'13'.repeat(32),'0000000000000000',fp);
 assert.equal(result.status,'passed');
 assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[id])).rows[0].n,0);
 await db.query('update ads set moderation_image_sha256=$2 where id=$1',[id,'13'.repeat(32)]);
 await db.query("select record_ad_safety_scan($1,'passed',null)",[id]);
 assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[id])).rows[0].n,1);
 assert.equal((await db.query('select moderation_status from ads where id=$1',[id])).rows[0].moderation_status,'pending_scan');
 await db.query('update ad_image_index_state set ready=false');
 const next=await ad(bob,'old index incomplete');await assert.rejects(scan(next,'15'.repeat(32),'ffffffffffffffff',fp),/BACKFILL_INCOMPLETE/);
 await db.query('update ad_image_index_state set ready=true');
});

test('invalid descriptors and browser access fail closed; service RPC remains callable',async()=>{
 const bad=[null,{}, {...original,version:'future'}, {...original,width:0}, {...original,regions:[]},
  {...original,regions:original.regions.map((r,i)=>i? r : {...r,hash:null})},
  {...original,regions:original.regions.map((r,i)=>i? r : {...r,contrast:1000})}];
 for(const fp of bad)await assert.rejects(backfill(legacy,fixtures.original.sha256,fp),/INVALID_FINGERPRINT/);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  try {
   await assert.rejects(backfill(legacy,fixtures.original.sha256,original),/permission denied/);
   await assert.rejects(scan(legacy,fixtures.original.sha256,fixtures.original.dhash,original),/permission denied/);
   await assert.rejects(db.query('select crop_fingerprint from ad_image_fingerprints'),/permission denied/);
   await assert.rejects(match(original,crop),/permission denied/);
  }finally{await db.exec('reset role');}
 }
 await db.exec('set role service_role');try{await backfill(legacy,fixtures.original.sha256,original);}finally{await db.exec('reset role');}
});

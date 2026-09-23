import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadOwnedImage, requireImageDimensions } from '../supabase/functions/_shared/storage-scan-policy.ts';

const root = new URL('../supabase/', import.meta.url);
const sql = path => readFileSync(new URL(path, root), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const path = `${owner}/00000000-0000-4000-8000-000000000003.png`;
const hash = '12'.repeat(32);
const otherHash = '34'.repeat(32);
let db, legacy, held;

before(async () => {
  db = new PGlite();
  await db.exec(`create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function storage.foldername(name text) returns text[] language sql immutable as
      $$ select string_to_array(regexp_replace(name,'/[^/]*$',''),'/') $$;
    create table storage.buckets(id text primary key,name text,public boolean,
      file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant all on storage.objects to anon,authenticated,service_role;
    insert into storage.buckets(id,name,public)
      values('ad-images','ad-images',true);
    -- Simulates a legacy overly broad hosted policy. The restrictive policy
    -- must still prevent public writes after migration.
    create policy old_broad_upload on storage.objects for all to authenticated
      using(true) with check(true);
    create policy old_anon_upload on storage.objects for all to anon
      using(true) with check(true);`);
  await db.exec(sql('staging/00_test_base.sql'));
  await db.query('insert into auth.users values($1),($2)',[owner,stranger]);
  legacy = (await db.query(`insert into ads(user_id,title,image_url,moderation_status)
    values($1,'Legacy','https://example.supabase.co/storage/v1/object/public/ad-images/old.jpg','approved')
    returning id`,[owner])).rows[0].id;
  held = (await db.query(`insert into ads(user_id,title,image_url,moderation_status)
    values($1,'Unsafe pending','https://example.supabase.co/storage/v1/object/public/ad-images/held.jpg','pending_scan')
    returning id`,[owner])).rows[0].id;
  await db.exec(sql('migrations/20260922_duplicate_screening.sql'));
  await db.exec(sql('migrations/20260923162944_ai_image_draft_quota.sql'));
});
after(async () => db?.close());

test('migration refuses unreviewed legacy public objects and retains approved legacy URL', async () => {
  const migration = sql('migrations/20260923170000_private_pending_images.sql');
  await assert.rejects(db.exec(migration),/UNREVIEWED_PUBLIC_IMAGES_REQUIRE_MANUAL_CLEANUP/);
  await db.exec('rollback');
  await db.query("update ads set image_url='' where id=$1",[held]);
  await db.exec(migration);
  const row = (await db.query('select moderation_status,image_url,image_publication_state from ads where id=$1',[legacy])).rows[0];
  assert.deepEqual(row,{
    moderation_status:'approved',
    image_url:'https://example.supabase.co/storage/v1/object/public/ad-images/old.jpg',
    image_publication_state:'legacy_public',
  });
});

test('old broad storage policy cannot grant authenticated mutation of public bucket', async () => {
  await db.query("insert into storage.objects values('ad-images','approved/old.jpg')");
  await db.exec(`set request.jwt.claim.sub='${owner}'; set role authenticated`);
  try {
    await assert.rejects(db.query("insert into storage.objects values('ad-images',$1)",[`${owner}/stolen.jpg`]),/row-level security/);
    await db.query("insert into storage.objects values('ad-pending-images',$1)",[path]);
    await assert.rejects(db.query("insert into storage.objects values('ad-pending-images',$1)",[`${stranger}/00000000-0000-4000-8000-000000000004.png`]),/row-level security/);
    const update=(await db.query("update storage.objects set name='changed.jpg' where bucket_id='ad-pending-images' returning name")).rows;
    const removal=(await db.query("delete from storage.objects where bucket_id='ad-images' returning name")).rows;
    assert.deepEqual(update,[]); assert.deepEqual(removal,[]);
    const seen=(await db.query("select name from storage.objects where bucket_id='ad-pending-images'")).rows.map(r=>r.name);
    assert.deepEqual(seen,[path]);
  } finally { await db.exec('reset role'); }
  await db.exec("set request.jwt.claim.sub=''; set role anon");
  try {
    await assert.rejects(db.query("insert into storage.objects values('ad-images','anon/public.png')"),/row-level security/);
    await assert.rejects(db.query("insert into storage.objects values('ad-pending-images',$1)",[path.replace('000000000003','000000000007')]),/row-level security/);
    assert.deepEqual((await db.query("select name from storage.objects where bucket_id='ad-pending-images'")).rows,[]);
  } finally { await db.exec('reset role'); }
});

test('browser supplied approval and publication fields are discarded at INSERT', async () => {
  const inserted = (await db.query(`insert into ads(user_id,title,image_url,image_storage_path,
      moderation_status,safety_status,duplicate_status,moderation_image_sha256,
      image_publication_state,image_index_required)
    values($1,'Private first','https://evil.invalid/public.jpg',$2,'approved',
      'passed','passed',$3,'legacy_public',true)
    returning id,image_url,moderation_status,safety_status,duplicate_status,
      moderation_image_sha256,image_publication_state,image_index_required`,
  [owner,path,hash])).rows[0];
  assert.equal(inserted.image_url,'');
  assert.equal(inserted.moderation_status,'pending_scan');
  assert.equal(inserted.safety_status,'pending');
  assert.equal(inserted.duplicate_status,'pending');
  assert.equal(inserted.moderation_image_sha256,null);
  assert.equal(inserted.image_publication_state,'pending');
  assert.equal(inserted.image_index_required,false);
  await assert.rejects(db.query(`insert into ads(user_id,title,image_url,image_storage_path)
    values($1,'Foreign','','${stranger}/00000000-0000-4000-8000-000000000004.png')`,[owner]),
  /INVALID_PRIVATE_IMAGE_PATH/);
  await assert.rejects(db.query(`insert into ads(user_id,title,image_url,image_storage_path,ai_source_request_id)
    values($1,'Forged AI','',$2,$3)`,[owner,`${owner}/00000000-0000-4000-8000-000000000005.png`,
    '00000000-0000-4000-8000-000000000006']),/INVALID_AI_DRAFT_SOURCE|AI_POST_ORIGIN_UNVERIFIED/);
  await assert.rejects(db.query("update ads set moderation_status='approved' where id=$1",[inserted.id]),
    /REQUIRED_SCREENING_OR_PUBLICATION_INCOMPLETE/);

  await db.query("select record_ad_duplicate_scan($1,$2,$3,$4)",
    [inserted.id,hash,'0123456789abcdef','dhash-9x8-luma-v1']);
  await db.query('update ads set moderation_image_sha256=$2 where id=$1',[inserted.id,hash]);
  await db.query("select record_ad_safety_scan($1,'passed',null)",[inserted.id]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[inserted.id])).rows[0].moderation_status,'pending_scan');
  await assert.rejects(db.query('select claim_ad_image_publication($1)',[inserted.id+999]),/IMAGE_NOT_READY_TO_PUBLISH/);

  await db.exec(`set request.jwt.claim.sub='${owner}'; set role authenticated`);
  try {
    await assert.rejects(db.query('select claim_ad_image_publication($1)',[inserted.id]),/permission denied/);
    const publicRows = (await db.query('select * from get_public_ads()')).rows;
    assert.ok(!publicRows.some(r=>r.id===inserted.id));
    const mine = (await db.query('select * from get_my_ads()')).rows;
    assert.equal(mine.find(r=>r.id===inserted.id)?.image_url,'');
  } finally { await db.exec('reset role'); }
  return inserted.id;
});

test('publication requires matching safety, duplicate and caller hashes, then is idempotent', async () => {
  const ad = (await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
    values($1,'Safe','','${path}') returning id`,[owner])).rows[0].id;
  await db.query("select record_ad_duplicate_scan($1,$2,$3,$4)",
    [ad,otherHash,'fedcba9876543210','dhash-9x8-luma-v1']);
  await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad,hash]);
  await db.query("select record_ad_safety_scan($1,'passed',null)",[ad]);
  await assert.rejects(db.query('select * from claim_ad_image_publication($1)',[ad]),/IMAGE_SCAN_HASH_MISMATCH/);
  await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad,otherHash]);
  const claim = (await db.query('select * from claim_ad_image_publication($1)',[ad])).rows[0];
  assert.equal(claim.expected_sha256,otherHash);
  assert.equal(claim.public_path,`${owner}/${ad}-${otherHash}`);
  const url = `https://example.supabase.co/storage/v1/object/public/ad-images/${claim.public_path}`;
  await assert.rejects(db.query('select complete_ad_image_publication($1,$2,$3,$4)',
    [ad,hash,claim.public_path,url]),/IMAGE_PUBLICATION_VERIFICATION_FAILED/);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[ad])).rows[0].moderation_status,'pending_scan');
  assert.equal((await db.query('select complete_ad_image_publication($1,$2,$3,$4) as result',
    [ad,otherHash,claim.public_path,url])).rows[0].result,'approved');
  assert.equal((await db.query('select complete_ad_image_publication($1,$2,$3,$4) as result',
    [ad,otherHash,claim.public_path,url])).rows[0].result,'already_public');
  const result=(await db.query('select image_url,moderation_status,published_image_sha256 from ads where id=$1',[ad])).rows[0];
  assert.deepEqual(result,{image_url:url,moderation_status:'approved',published_image_sha256:otherHash});
});

test('either scan order enqueues one durable job and failures leave it for retry', async () => {
  for (const [index,order,visual] of [[0,'duplicate_first','0000000000000000'],
    [1,'safety_first','ffffffffffffffff']]) {
    const ad=(await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
      values($1,$2,'',$3) returning id`,[stranger,order,
      `${stranger}/00000000-0000-4000-8000-00000000000${index}.png`])).rows[0].id;
    const duplicate=()=>db.query('select record_ad_duplicate_scan($1,$2,$3,$4)',
      [ad,`${index+5}`.repeat(64),visual,'dhash-9x8-luma-v1']);
    const safety=async()=>{
      await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad,`${index+5}`.repeat(64)]);
      await db.query("select record_ad_safety_scan($1,'passed',null)",[ad]);
    };
    if (order==='duplicate_first') { await duplicate(); await safety(); }
    else { await safety(); await duplicate(); }
    const queue=(await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[ad])).rows[0];
    assert.equal(queue.n,1);
    assert.equal((await db.query('select moderation_status from ads where id=$1',[ad])).rows[0].moderation_status,'pending_scan');
    await db.query('select * from claim_ad_image_publication($1)',[ad]);
    assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[ad])).rows[0].n,1);
  }
});

test('oversize dimensions and object replacement are rejected before approval', async () => {
  const png = new Uint8Array(readFileSync(new URL('./fixtures/images/valid.png',import.meta.url)));
  const oversized = png.slice(); oversized.set([0,0,16,1],16);
  assert.throws(()=>requireImageDimensions(oversized,'image/png'),/dimensions/);
  const bucket = {
    async info() { return {data:{size:png.length,contentType:'image/png'},error:null}; },
    async download() { return {data:new Blob([png.slice(0,-1)]),error:null}; },
  };
  await assert.rejects(loadOwnedImage(bucket,owner,path),/size changed/);
});

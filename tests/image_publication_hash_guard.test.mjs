import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const sql = name => readFileSync(new URL(`../supabase/${name}`,import.meta.url),'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const privatePath = `${owner}/00000000-0000-4000-8000-000000000002.jpg`;
const sha = 'ab'.repeat(32);

test('publication completion rejects missing scan evidence, including idempotent retry',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create role anon; create role authenticated; create role service_role bypassrls;
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
      insert into storage.buckets(id,name,public) values('ad-images','ad-images',true);`);
    await db.exec(sql('staging/00_test_base.sql'));
    await db.query('insert into auth.users values($1)',[owner]);
    for(const name of [
      '20260922_duplicate_screening.sql',
      '20260923162944_ai_image_draft_quota.sql',
      '20260923170000_private_pending_images.sql',
      '20260923180000_ai_canonical_post.sql',
      '20260924012243_image_publication_hash_guard.sql',
    ]) await db.exec(sql(`migrations/${name}`));

    const ad=(await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
      values($1,'Hash guard','',$2) returning id`,[owner,privatePath])).rows[0].id;
    await db.query('select record_ad_duplicate_scan($1,$2,$3,$4)',
      [ad,sha,'0123456789abcdef','dhash-9x8-luma-v1']);
    await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad,sha]);
    await db.query("select record_ad_safety_scan($1,'passed',null)",[ad]);
    const claim=(await db.query('select * from claim_ad_image_publication($1)',[ad])).rows[0];
    assert.equal(claim.expected_sha256,sha);
    const url=`https://example.supabase.co/storage/v1/object/public/ad-images/${claim.public_path}`;
    const complete=()=>db.query('select complete_ad_image_publication($1,$2,$3,$4) result',
      [ad,sha,claim.public_path,url]);
    const assertStillPending=async()=>{
      const row=(await db.query(`select image_publication_state,moderation_status,
        published_image_sha256,image_url from ads where id=$1`,[ad])).rows[0];
      assert.deepEqual(row,{
        image_publication_state:'publishing', moderation_status:'pending_scan',
        published_image_sha256:null, image_url:'',
      });
    };

    // A scanner row can disappear after claim, leaving encode(...) as NULL.
    await db.query('delete from ad_image_fingerprints where ad_id=$1',[ad]);
    await assert.rejects(complete(),/IMAGE_PUBLICATION_VERIFICATION_FAILED/);
    await assertStillPending();
    await db.query(`insert into ad_image_fingerprints(ad_id,sha256,visual_hash,visual_hash_version)
      values($1,decode($2,'hex'),('x0123456789abcdef')::bit(64),'dhash-9x8-luma-v1')`,[ad,sha]);

    // NULL stored safety hash also made the previous <> guard indeterminate.
    await db.query('update ads set moderation_image_sha256=null where id=$1',[ad]);
    await assert.rejects(complete(),/IMAGE_PUBLICATION_VERIFICATION_FAILED/);
    await assertStillPending();
    await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad,sha]);

    assert.equal((await complete()).rows[0].result,'approved');
    assert.equal((await complete()).rows[0].result,'already_public');
    await db.query('delete from ad_image_fingerprints where ad_id=$1',[ad]);
    await assert.rejects(complete(),/IMAGE_PUBLICATION_VERIFICATION_FAILED/);
    assert.equal((await db.query('select moderation_status from ads where id=$1',[ad])).rows[0].moderation_status,'approved');

    await db.exec('set role authenticated');
    await assert.rejects(complete(),/permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});

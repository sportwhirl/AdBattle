import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const sql = path => readFileSync(new URL(`../supabase/${path}`,import.meta.url),'utf8');
const reviewer='00000000-0000-4000-8000-000000000001';
const owner='00000000-0000-4000-8000-000000000002';
const session='00000000-0000-4000-8000-000000000003';
const hash='a1'.repeat(32);

test('moderator clearance of private images queues publication; both checks and verified publisher completion remain required',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create schema auth; create schema storage;
      create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key,is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users,not_after timestamptz);
      create function auth.jwt() returns jsonb language sql as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
      create function auth.uid() returns uuid language sql as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function storage.foldername(name text) returns text[] language sql immutable as
        $$ select string_to_array(regexp_replace(name,'/[^/]*$',''),'/') $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
      grant usage on schema public,auth,storage to anon,authenticated,service_role;
      insert into storage.buckets values('ad-images','ad-images',true,null,null);
      insert into auth.users(id) values('${reviewer}'),('${owner}');
      insert into auth.sessions(id,user_id) values('${session}','${reviewer}');`);
    for(const path of ['staging/00_test_base.sql','migrations/20260922_duplicate_screening.sql',
      'migrations/20260923162944_ai_image_draft_quota.sql','migrations/20260923164716_private_moderation_review.sql',
      'migrations/20260923170000_private_pending_images.sql']) await db.exec(sql(path));
    await db.query("insert into moderation_private.reviewers(user_id,granted_by,reason) values($1,'test-operator','Verified fixture reviewer')",[reviewer]);
    async function fixture(user,safety){
      const ad=(await db.query("insert into ads(user_id,title,caption,image_url,image_storage_path) values($1::uuid,'Private creative','Test','',$1::uuid::text || '/00000000-0000-4000-8000-000000000009.png') returning id",[user])).rows[0].id;
      await db.query("select record_ad_duplicate_scan($1,$2,'0123456789abcdef','dhash-9x8-luma-v1')",[ad,hash]);
      await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad,hash]);
      await db.query('select record_ad_safety_scan($1,$2,null)',[ad,safety]);
      return ad;
    }
    async function clear(ad,kind,requestId){
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:reviewer,session_id:session})]);
      await db.exec('set role authenticated');
      try {
        const detail=(await db.query('select moderator_ad($1) result',[ad])).rows[0].result;
        return (await db.query("select moderator_decide($1,$2,$3,'clear','Inspected both private creatives',$4) result",[requestId,ad,kind,detail.version])).rows[0].result;
      } finally {await db.exec('reset role');}
    }
    const original=await fixture(owner,'held');
    assert.equal((await clear(original,'safety','00000000-0000-4000-8000-000000000011')).moderation_status,'pending_scan');
    assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[original])).rows[0].n,1);
    const claim=(await db.query('select * from claim_ad_image_publication($1)',[original])).rows[0];
    const publicUrl=`https://example.supabase.co/storage/v1/object/public/ad-images/${claim.public_path}`;
    assert.equal((await db.query('select complete_ad_image_publication($1,$2,$3,$4) result',[original,hash,claim.public_path,publicUrl])).rows[0].result,'approved');
    const similar=await fixture(reviewer,'held');
    assert.equal((await clear(similar,'safety','00000000-0000-4000-8000-000000000012')).moderation_status,'pending_scan');
    assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[similar])).rows[0].n,0);
    const result=await clear(similar,'duplicate','00000000-0000-4000-8000-000000000013');
    assert.equal(result.safety_status,'passed');assert.equal(result.duplicate_status,'passed');assert.equal(result.moderation_status,'pending_scan');
    const row=(await db.query('select image_url,image_publication_state from ads where id=$1',[similar])).rows[0];
    assert.deepEqual(row,{image_url:'',image_publication_state:'pending'});
    assert.equal((await db.query('select count(*)::int n from ad_image_publication_queue where ad_id=$1',[similar])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from moderation_private.decisions where ad_id=$1',[similar])).rows[0].n,2);
    assert.equal((await db.query('select moderation_status from ads where id=$1',[original])).rows[0].moderation_status,'approved');
  } finally {await db.close();}
});

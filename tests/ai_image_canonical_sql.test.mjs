import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const sql = path => readFileSync(new URL(`../supabase/${path}`,import.meta.url),'utf8');
const owner='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const draftId='00000000-0000-4000-8000-000000000321';
const pendingPath=`${owner}/00000000-0000-4000-8000-000000000322.jpg`;
const canonical='ab'.repeat(32);
const wrong='cd'.repeat(32);

async function database(){
  const db=new PGlite();
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
    insert into storage.buckets(id,name,public)
      values('ad-images','ad-images',true);`);
  await db.exec(sql('staging/00_test_base.sql'));
  await db.query('insert into auth.users values($1),($2)',[owner,other]);
  for(const name of ['20260922_duplicate_screening.sql',
    '20260923162944_ai_image_draft_quota.sql',
    '20260923170000_private_pending_images.sql',
    '20260923180000_ai_canonical_post.sql']){
    await db.exec(sql('migrations/'+name));
  }
  return db;
}

async function insertDraft(db,userId=owner,id=draftId){
  await db.query(`insert into ai_image_draft_requests
    (request_id,user_id,day_utc,prompt_sha256,style,aspect_ratio,status,
      output_path,output_sha256,post_path,post_sha256,post_bytes,post_width,post_height)
    values($1,$2,(now() at time zone 'utc')::date,$3,'freeform_simple','16:9',
      'completed',$4,$5,$6,$7,10000,640,360)`,
    [id,userId,'12'.repeat(32),`${userId}/${id}.jpg`,'34'.repeat(32),
      `${userId}/${id}.post.jpg`,canonical]);
}

test('browser cannot forge AI provenance; service insert stamps immutable canonical hash',async()=>{
  const db=await database();
  try{
    await insertDraft(db);
    const triggerNames=(await db.query(`select tgname from pg_trigger
      where tgrelid='public.ads'::regclass and not tgisinternal
      order by tgname`)).rows.map(row=>row.tgname);
    assert.ok(triggerNames.indexOf('enforce_ad_screening_gate') <
      triggerNames.indexOf('set_ad_ai_origin'));
    await db.exec(`create function public.test_client_ai_insert(p_user uuid,p_path text,p_source uuid)
      returns void language plpgsql security invoker set search_path='' as $$
      begin
        insert into public.ads(user_id,title,image_url,image_storage_path,ai_source_request_id)
          values(p_user,'RPC forged','',p_path,p_source);
      end $$;
      grant execute on function public.test_client_ai_insert(uuid,text,uuid) to authenticated;`);
    await db.exec(`set request.jwt.claim.sub='${owner}';
      set request.jwt.claims='{"role":"authenticated","sub":"${owner}"}';
      set role authenticated`);
    try{
      await assert.rejects(db.query(`insert into ads(user_id,title,image_url,image_storage_path,ai_source_request_id)
        values($1,'Forged','',$2,$3)`,[owner,pendingPath,draftId]),/AI_POST_SERVICE_REQUIRED/);
      await db.exec('rollback');
      await assert.rejects(db.query('select test_client_ai_insert($1,$2,$3)',
        [owner,pendingPath,draftId]),/AI_POST_SERVICE_REQUIRED/);
      await db.exec('rollback');
      // A hypothetical exposed RPC that changes request claims still cannot
      // change the invoker database role of the screening trigger.
      await db.exec(`set request.jwt.claims='{"role":"service_role"}'`);
      await assert.rejects(db.query(`insert into ads(user_id,title,image_url,image_storage_path,ai_source_request_id)
        values($1,'Forged again','',$2,$3)`,[owner,pendingPath,draftId]),/AI_POST_SERVICE_REQUIRED/);
      await db.exec('rollback');
    }finally{await db.exec('reset role');}
    await db.exec(`set request.jwt.claims='{"role":"service_role"}'; set role service_role`);
    let ad;
    try{
      ad=(await db.query(`insert into ads(user_id,title,image_url,image_storage_path,
          ai_source_request_id,ai_generated,ai_post_sha256,moderation_status)
        values($1,'Trusted','https://evil.invalid',$2,$3,false,$4,'approved')
        returning id,ai_generated,ai_post_sha256,moderation_status,image_url,
          image_publication_state`,[owner,pendingPath,draftId,wrong])).rows[0];
    }finally{await db.exec('reset role');}
    assert.equal(ad.ai_generated,true);
    assert.equal(ad.ai_post_sha256,canonical);
    assert.equal(ad.image_url,'');
    assert.equal(ad.moderation_status,'pending_scan');
    assert.equal(ad.image_publication_state,'pending');
    await assert.rejects(db.query('update ads set ai_post_sha256=$2 where id=$1',
      [ad.id,wrong]),/AD_AI_ORIGIN_IMMUTABLE/);
    await db.exec('rollback');
    await assert.rejects(db.query('update ai_image_draft_requests set post_sha256=$2 where request_id=$1',
      [draftId,wrong]),/COMPLETED_AI_DRAFT_IMMUTABLE/);
    await db.exec('rollback');

    await db.query('select record_ad_duplicate_scan($1,$2,$3,$4)',
      [ad.id,wrong,'0123456789abcdef','dhash-9x8-luma-v1']);
    await db.query('update ads set moderation_image_sha256=$2 where id=$1',[ad.id,wrong]);
    await db.query("select record_ad_safety_scan($1,'passed',null)",[ad.id]);
    await assert.rejects(db.query('select claim_ad_image_publication($1)',[ad.id]),
      /AI_CANONICAL_IMAGE_HASH_MISMATCH/);
    await db.exec('rollback');
    assert.equal((await db.query('select image_publication_state from ads where id=$1',
      [ad.id])).rows[0].image_publication_state,'pending');
  }finally{await db.close();}
});

test('failed publication jobs are deferred so fresh queued ads enter a ten-job sweep',async()=>{
  const db=await database();
  try{
    const ids=[];
    for(let i=0;i<11;i++){
      ids.push((await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
        values($1,$2,'',$3) returning id`,[owner,`queue ${i}`,
        `${owner}/00000000-0000-4000-8000-${String(i+10).padStart(12,'0')}.jpg`])).rows[0].id);
    }
    for(let i=0;i<10;i++){
      await db.query('insert into ad_image_publication_queue(ad_id) values($1)',[ids[i]]);
      await db.query('select defer_ad_image_publication($1)',[ids[i]]);
    }
    await db.query('insert into ad_image_publication_queue(ad_id) values($1)',[ids[10]]);
    const eligible=(await db.query(`select ad_id from ad_image_publication_queue
      where next_attempt_at <= now() order by next_attempt_at,created_at limit 10`)).rows;
    assert.deepEqual(eligible.map(row=>row.ad_id),[ids[10]]);
    const deferred=(await db.query('select attempts,next_attempt_at > now() future from ad_image_publication_queue where ad_id=$1',
      [ids[0]])).rows[0];
    assert.deepEqual(deferred,{attempts:1,future:true});
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select defer_ad_image_publication($1)',[ids[10]]),/permission denied/);
    await db.exec('reset role');
  }finally{await db.close();}
});

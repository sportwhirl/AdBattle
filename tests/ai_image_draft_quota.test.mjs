import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/20260923162944_ai_image_draft_quota.sql', import.meta.url), 'utf8');
const base = readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url), 'utf8');
const duplicate = readFileSync(new URL('../supabase/migrations/20260922_duplicate_screening.sql', import.meta.url), 'utf8');
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const hash = 'a'.repeat(64);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('private draft quota is atomic, one-active, service-only and idempotent', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public,auth to authenticated;
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
    `);
    await db.exec(base);
    await db.exec(duplicate);
    await db.query('insert into auth.users values ($1),($2)', [alice,bob]);
    await db.exec(migration);
    const bucket = (await db.query("select public,file_size_limit,allowed_mime_types from storage.buckets where id='ai-image-drafts'")).rows[0];
    assert.equal(bucket.public, false);
    assert.equal(bucket.file_size_limit, 8388608);
    assert.deepEqual(bucket.allowed_mime_types, ['image/jpeg', 'image/png']);
    const reserve = (user, request, userCap=3, globalCap=30) =>
      db.query('select * from reserve_ai_image_draft($1,$2,$3,$4,$5,$6,$7)',
        [user, request, hash, 'pixel_art', '16:9', userCap, globalCap]).then(result => result.rows[0]);

    assert.equal((await reserve(alice,id(100))).reservation_status, 'reserved');
    assert.equal((await reserve(alice,id(100))).reservation_status, 'reserved_replay');
    assert.equal((await reserve(alice,id(101))).reservation_status, 'active');
    assert.equal((await db.query('select count(*)::int n from ai_image_draft_requests')).rows[0].n, 1);
    await assert.rejects(
      db.query('select * from reserve_ai_image_draft($1,$2,$3,$4,$5,3,30)',
        [bob,id(100),hash,'pixel_art','16:9']), /AI_IMAGE_REQUEST_CONFLICT/);
    await db.exec('rollback');
    await assert.rejects(
      db.query('select * from reserve_ai_image_draft($1,$2,$3,$4,$5,4,30)',
        [alice,id(102),hash,'pixel_art','16:9']), /INVALID_AI_IMAGE_RESERVATION/);
    await db.exec('rollback');

    await db.query("update ai_image_draft_requests set status='completed',output_path=$1 where request_id=$2",
      [`${alice}/draft.jpg`,id(100)]).catch(async error => {
        // A completed draft must have its image checksum.
        assert.match(error.message, /completed_draft_has_output/);
        await db.exec('rollback');
      });
    await db.query("update ai_image_draft_requests set status='completed',output_path=$1,output_sha256=$2 where request_id=$3",
      [`${alice}/draft.jpg`,'b'.repeat(64),id(100)]);
    assert.deepEqual(await reserve(alice,id(100)), {
      reservation_status:'completed',draft_path:`${alice}/draft.jpg`
    });
    assert.equal((await reserve(alice,id(102))).reservation_status, 'reserved');
    await db.query("update ai_image_draft_requests set status='failed' where request_id=$1", [id(102)]);
    assert.equal((await reserve(alice,id(103))).reservation_status, 'reserved');
    await db.query("update ai_image_draft_requests set status='unknown' where request_id=$1", [id(103)]);
    assert.equal((await reserve(alice,id(104))).reservation_status, 'user_limit');
    assert.equal((await reserve(bob,id(105),3,3)).reservation_status, 'global_limit');

    await assert.rejects(db.query(`insert into ads(user_id,title,image_url,ai_source_request_id)
      values($1,'Bad origin','https://example.invalid/image.jpg',$2)`, [bob,id(100)]), /INVALID_AI_DRAFT_SOURCE/);
    await db.exec('rollback');
    const generated = (await db.query(`insert into ads(user_id,title,image_url,ai_source_request_id)
      values($1,'Generated','https://example.invalid/image.jpg',$2)
      returning id,ai_generated`, [alice,id(100)])).rows[0];
    assert.equal(generated.ai_generated, true);
    const ordinary = (await db.query(`insert into ads(user_id,title,image_url,ai_generated)
      values($1,'Ordinary','https://example.invalid/image.jpg',true)
      returning ai_generated`, [bob])).rows[0];
    assert.equal(ordinary.ai_generated, false);
    await db.query("update ads set safety_status='passed',duplicate_status='passed',moderation_status='approved' where id=$1",[generated.id]);
    assert.equal((await db.query('select ai_generated from get_public_ads_with_ai() where id=$1',[generated.id])).rows[0].ai_generated,true);

    await db.exec('set role authenticated');
    await assert.rejects(db.query('select count(*) from ai_image_draft_requests'), /permission denied/);
    await assert.rejects(db.query('select * from reserve_ai_image_draft($1,$2,$3,$4,$5,3,30)',
      [alice,id(106),hash,'pixel_art','16:9']), /permission denied/);
    await db.exec('reset role');

    await db.query(`insert into ai_image_draft_requests
      (request_id,user_id,day_utc,prompt_sha256,style,aspect_ratio,status,output_path,output_sha256)
      values($1,$2,(now() at time zone 'utc')::date,$3,'hand_drawn','1:1','completed',$4,$5)`,
      [id(107),alice,hash,`${alice}/other.jpg`,'c'.repeat(64)]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [alice]);
    await db.exec('set role authenticated');
    await db.query(`insert into ads(user_id,title,image_url,ai_source_request_id)
      values($1,'Creator post','https://example.invalid/creator.jpg',$2)`,[alice,id(107)]);
    const mine = (await db.query("select ai_generated from get_my_ads_with_ai() where title='Creator post'")).rows[0];
    assert.equal(mine.ai_generated,true);
    await db.exec('reset role');
  } finally {
    await db.close();
  }
});

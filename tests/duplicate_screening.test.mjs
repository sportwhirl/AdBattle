import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const base = readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260922_duplicate_screening.sql', import.meta.url), 'utf8');
let db;
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';

async function addAd(user, title) {
  return (await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
    values($1,$2,'https://example.invalid/original.png',$2||'.png') returning id`, [user,title])).rows[0].id;
}
async function scan(id, sha, visual) {
  return (await db.query('select record_ad_duplicate_scan($1,$2,$3,$4) as result',
    [id,sha,visual,'dhash-9x8-luma-v1'])).rows[0].result;
}

before(async () => {
  db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.exec(base);
  await db.exec(migration);
  await db.query('insert into auth.users values($1),($2)', [alice,bob]);
});
after(async () => db.close());

test('same-creator exact duplicates point to the existing ad', async () => {
  const first = await addAd(alice,'same-first');
  const second = await addAd(alice,'same-second');
  assert.equal((await scan(first,'01'.repeat(32),'0123456789abcdef')).status,'passed');
  assert.deepEqual(await scan(second,'01'.repeat(32),'fedcba9876543210'),
    {status:'duplicate_same_creator',matched_ad_id:first,visual_distance:0});
  const row = (await db.query('select moderation_status from ads where id=$1',[second])).rows[0];
  assert.equal(row.moderation_status,'pending_scan');
});

test('different-creator exact and simultaneous submissions are held', async () => {
  const existing = await addAd(alice,'existing-indexed');
  await scan(existing,'02'.repeat(32),'1111111111111111');
  const other = await addAd(bob,'other-exact');
  assert.equal((await scan(other,'02'.repeat(32),'9999999999999999')).status,'review_identical');

  const one = await addAd(alice,'race-one');
  const two = await addAd(bob,'race-two');
  const results = await Promise.all([
    scan(one,'03'.repeat(32),'3333333333333333'),
    scan(two,'03'.repeat(32),'3333333333333333'),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(),['passed','review_identical']);
});

test('close visual match is held while a distant image passes', async () => {
  const source = await addAd(alice,'visual-source');
  await scan(source,'04'.repeat(32),'0000000000000000');
  const recompressed = await addAd(bob,'recompressed');
  assert.equal((await scan(recompressed,'05'.repeat(32),'000000000000000f')).status,'review_similar');
  const genuinelyDifferent = await addAd(bob,'genuinely-different');
  assert.equal((await scan(genuinelyDifferent,'06'.repeat(32),'ffffffffffffffff')).status,'passed');
});

test('failed scans and either incomplete check cannot publish', async () => {
  const failed = await addAd(alice,'failed');
  await db.query("select record_ad_duplicate_scan_failure($1,'decoder stopped')",[failed]);
  await db.query("select record_ad_safety_scan($1,'passed',null)",[failed]);
  assert.deepEqual((await db.query('select moderation_status,duplicate_status from ads where id=$1',[failed])).rows[0],
    {moderation_status:'pending_scan',duplicate_status:'pending'});
  await assert.rejects(db.query("update ads set moderation_status='approved' where id=$1",[failed]),/REQUIRED_SCREENING_INCOMPLETE/);

  const safetyHeld = await addAd(bob,'safety-held');
  await scan(safetyHeld,'07'.repeat(32),'7777777777777777');
  await db.query("select record_ad_safety_scan($1,'held','manual review')",[safetyHeld]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[safetyHeld])).rows[0].moderation_status,'pending_scan');
});

test('only both independent passes approve an ad', async () => {
  const ad = await addAd(alice,'both-pass');
  await db.query("select record_ad_safety_scan($1,'passed',null)",[ad]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[ad])).rows[0].moderation_status,'pending_scan');
  await scan(ad,'08'.repeat(32),'8888888888888888');
  assert.equal((await db.query('select moderation_status from ads where id=$1',[ad])).rows[0].moderation_status,'approved');
});

test('attribution schema uses an owner-saved handle and reports missing profiles', async () => {
  await db.query('insert into creator_profiles(user_id,handle) values($1,$2)',[alice,'alice_art']);
  assert.equal((await db.query('select handle from creator_profiles where user_id=$1',[alice])).rows[0].handle,'alice_art');
  assert.equal((await db.query('select count(*)::int as n from creator_profiles where user_id=$1',[bob])).rows[0].n,0);
});

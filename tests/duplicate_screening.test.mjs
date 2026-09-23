import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const base = readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260922_duplicate_screening.sql', import.meta.url), 'utf8');
let db;
let legacyApproved;
let legacyException;
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
async function resolveReview(id, decision, reviewer='moderator-1', reason='Reviewed against the matched creative') {
  return (await db.query('select resolve_ad_duplicate_review($1,$2,$3,$4) as result',
    [id,decision,reviewer,reason])).rows[0].result;
}

before(async () => {
  db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.exec(base);
  await db.query('insert into auth.users values($1),($2)', [alice,bob]);
  legacyApproved = (await db.query(`insert into ads(user_id,title,image_url,moderation_status)
    values($1,'legacy-approved','https://example.invalid/legacy.png','approved') returning id`,[alice])).rows[0].id;
  legacyException = (await db.query(`insert into ads(user_id,title,image_url)
    values($1,'legacy-no-object','https://example.invalid/missing.png') returning id`,[bob])).rows[0].id;
  await db.exec(migration);
});
after(async () => db.close());

test('service-only legacy backfill indexes approved ads without unpublishing them', async () => {
  const before=(await db.query('select moderation_status,duplicate_status,image_index_required from ads where id=$1',[legacyApproved])).rows[0];
  assert.deepEqual(before,{moderation_status:'approved',duplicate_status:'passed',image_index_required:true});
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select record_ad_legacy_fingerprint($1,$2,$3,$4)',
    [legacyApproved,'aa'.repeat(32),'aaaaaaaaaaaaaaaa','dhash-9x8-luma-v1']),/permission denied/);
  await db.exec('reset role');
  const result=(await db.query('select record_ad_legacy_fingerprint($1,$2,$3,$4) result',
    [legacyApproved,'aa'.repeat(32),'aaaaaaaaaaaaaaaa','dhash-9x8-luma-v1'])).rows[0].result;
  assert.deepEqual(result,{status:'legacy_indexed',publication_status:'approved'});
  assert.equal((await db.query('select moderation_status from ads where id=$1',[legacyApproved])).rows[0].moderation_status,'approved');
  assert.equal((await db.query('select count(*)::int n from ad_image_fingerprints where ad_id=$1',[legacyApproved])).rows[0].n,1);
  await assert.rejects(db.query("select complete_ad_image_index_backfill('all legacy ads reviewed','operator-1')"),/ACCOUNTING_INCOMPLETE/);
  await db.query("select record_ad_image_index_exception($1,'verified source object is unavailable','operator-1')",[legacyException]);
  await db.query("select complete_ad_image_index_backfill('all legacy ads reviewed','operator-1')");
  assert.equal((await db.query('select ready from ad_image_index_state')).rows[0].ready,true);
});

test('same-creator exact duplicates point to the existing ad', async () => {
  const first = await addAd(alice,'same-first');
  const second = await addAd(alice,'same-second');
  assert.equal((await scan(first,'01'.repeat(32),'0123456789abcdef')).status,'passed');
  assert.deepEqual(await scan(second,'01'.repeat(32),'fedcba9876543210'),
    {status:'duplicate_same_creator',matched_ad_id:first,visual_distance:0});
  const row = (await db.query('select moderation_status,duplicate_status,duplicate_of_ad_id from ads where id=$1',[second])).rows[0];
  assert.deepEqual(row,{moderation_status:'pending_scan',duplicate_status:'duplicate_same_creator',duplicate_of_ad_id:first});
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

test('duplicate and safety passes may finish in either order but neither publishes alone', async () => {
  const duplicateFirst = await addAd(alice,'duplicate-first');
  await scan(duplicateFirst,'09'.repeat(32),'55aa55aa55aa55aa');
  assert.equal((await db.query('select moderation_status from ads where id=$1',[duplicateFirst])).rows[0].moderation_status,'pending_scan');
  await db.query("select record_ad_safety_scan($1,'passed',null)",[duplicateFirst]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[duplicateFirst])).rows[0].moderation_status,'approved');

  const safetyFirst = await addAd(bob,'safety-first');
  await db.query("select record_ad_safety_scan($1,'passed',null)",[safetyFirst]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[safetyFirst])).rows[0].moderation_status,'pending_scan');
  await scan(safetyFirst,'0a'.repeat(32),'aa55aa55aa55aa55');
  assert.equal((await db.query('select moderation_status from ads where id=$1',[safetyFirst])).rows[0].moderation_status,'approved');
});

test('safety hold, rejection, and scanner failure remain fail closed', async () => {
  const held = await addAd(alice,'held-by-safety');
  await scan(held,'0b'.repeat(32),'bbbbbbbbbbbbbbbb');
  await db.query("select record_ad_safety_scan($1,'held','policy review required')",[held]);
  assert.deepEqual((await db.query('select moderation_status,safety_status from ads where id=$1',[held])).rows[0],
    {moderation_status:'pending_scan',safety_status:'held'});

  const rejected = await addAd(bob,'rejected-by-safety');
  await scan(rejected,'0c'.repeat(32),'cccccccccccccccc');
  await db.query("select record_ad_safety_scan($1,'failed','safety violation')",[rejected]);
  assert.deepEqual((await db.query('select moderation_status,safety_status from ads where id=$1',[rejected])).rows[0],
    {moderation_status:'rejected',safety_status:'failed'});

  const errored = await addAd(alice,'safety-error');
  await scan(errored,'0d'.repeat(32),'dddddddddddddddd');
  await db.query(`update ads set moderation_last_error='OpenAI unavailable',
    moderation_attempts=1,moderation_scan_version='adbattle-scanner-v2-2026-09' where id=$1`,[errored]);
  assert.deepEqual((await db.query('select moderation_status,safety_status,moderation_last_error from ads where id=$1',[errored])).rows[0],
    {moderation_status:'pending_scan',safety_status:'pending',moderation_last_error:'OpenAI unavailable'});
  await db.query("select record_ad_safety_scan($1,'passed','Retry completed safely')",[errored]);
  assert.deepEqual((await db.query('select moderation_status,safety_status from ads where id=$1',[errored])).rows[0],
    {moderation_status:'approved',safety_status:'passed'});
});

test('safety decisions are terminal and repeated identical results are idempotent', async () => {
  for (const [status,expectedModeration] of [
    ['passed','pending_scan'],
    ['held','pending_scan'],
    ['failed','rejected'],
  ]) {
    const ad=await addAd(alice,`terminal-${status}`);
    await db.query('select record_ad_safety_scan($1,$2,$3)',[ad,status,`Original ${status} reason`]);
    assert.deepEqual((await db.query('select safety_status,moderation_status,moderation_reason from ads where id=$1',[ad])).rows[0],
      {safety_status:status,moderation_status:expectedModeration,moderation_reason:`Original ${status} reason`});
    await db.query('select record_ad_safety_scan($1,$2,$3)',[ad,status,`Replacement ${status} reason`]);
    assert.deepEqual((await db.query('select safety_status,moderation_status,moderation_reason from ads where id=$1',[ad])).rows[0],
      {safety_status:status,moderation_status:expectedModeration,moderation_reason:`Original ${status} reason`});
  }
});

test('terminal safety results cannot be replaced by scanner or direct RPC retries', async () => {
  for (const [initial,replacements] of [
    ['passed',['held','failed']],
    ['held',['passed','failed']],
    ['failed',['passed','held']],
  ]) {
    const ad=await addAd(bob,`immutable-${initial}`);
    await db.query('select record_ad_safety_scan($1,$2,$3)',[ad,initial,`Terminal ${initial} decision`]);
    for (const replacement of replacements) {
      await assert.rejects(
        db.query('select record_ad_safety_scan($1,$2,$3)',[ad,replacement,'Conflicting retry result']),
        /SAFETY_STATUS_TERMINAL/,
      );
    }
    assert.equal((await db.query('select safety_status from ads where id=$1',[ad])).rows[0].safety_status,initial);
  }
});

test('duplicate state cannot cause a completed safety result to transition', async () => {
  const source=await addAd(alice,'terminal-duplicate-source');
  await scan(source,'ee'.repeat(32),'abcdef0123456789');
  const held=await addAd(bob,'terminal-duplicate-hold');
  await scan(held,'ee'.repeat(32),'9876543210fedcba');
  await db.query("select record_ad_safety_scan($1,'passed','Safety completed once')",[held]);
  assert.deepEqual((await db.query('select safety_status,duplicate_status,moderation_status from ads where id=$1',[held])).rows[0],
    {safety_status:'passed',duplicate_status:'review_identical',moderation_status:'pending_scan'});
  await db.query("select record_ad_safety_scan($1,'passed','Webhook retry must be a no-op')",[held]);
  assert.deepEqual((await db.query('select safety_status,duplicate_status,moderation_status,moderation_reason from ads where id=$1',[held])).rows[0],
    {safety_status:'passed',duplicate_status:'review_identical',moderation_status:'pending_scan',moderation_reason:'Safety completed once'});
});

test('historical safety risk metadata and audit events are retained', async () => {
  const ad = await addAd(alice,'audited-safety-result');
  const details={moderation:{flagged:false},policy_review:{decision:'approve'}};
  await db.query(`update ads set moderation_details=$2,moderation_risk_score=17,
    moderation_scan_version='adbattle-scanner-v2-2026-09',moderation_image_sha256=$3,
    moderation_attempts=1,moderation_last_attempt_at=now() where id=$1`,[ad,details,'ab'.repeat(32)]);
  await db.query(`insert into moderation_events(ad_id,stage,outcome,details)
    values($1,'final_decision','approved',$2)`,[ad,{risk_score:17,image_sha256:'ab'.repeat(32)}]);
  await db.query("select record_ad_safety_scan($1,'passed',null)",[ad]);
  const row=(await db.query(`select moderation_status,safety_status,moderation_risk_score,
    moderation_scan_version,moderation_image_sha256,moderation_attempts,moderation_details
    from ads where id=$1`,[ad])).rows[0];
  assert.deepEqual(row,{moderation_status:'pending_scan',safety_status:'passed',moderation_risk_score:17,
    moderation_scan_version:'adbattle-scanner-v2-2026-09',moderation_image_sha256:'ab'.repeat(32),
    moderation_attempts:1,moderation_details:details});
  assert.equal((await db.query('select count(*)::int n from moderation_events where ad_id=$1',[ad])).rows[0].n,1);
});

test('review_identical clearance preserves evidence and waits for safety', async () => {
  const source=await addAd(alice,'review-clear-identical-source');
  await scan(source,'e1'.repeat(32),'1020304050607080');
  const held=await addAd(bob,'review-clear-identical-target');
  assert.equal((await scan(held,'e1'.repeat(32),'ffeeddccbbaa9988')).status,'review_identical');
  const before=(await db.query('select duplicate_of_ad_id,moderation_details from ads where id=$1',[held])).rows[0];
  const result=await resolveReview(held,'CLEAR','moderator-alex','Permission confirmed with the creator');
  assert.deepEqual(result,{status:'passed',decision:'clear',matched_ad_id:source});
  const after=(await db.query(`select duplicate_status,moderation_status,duplicate_of_ad_id,
    moderation_details from ads where id=$1`,[held])).rows[0];
  assert.deepEqual(after,{duplicate_status:'passed',moderation_status:'pending_scan',
    duplicate_of_ad_id:before.duplicate_of_ad_id,moderation_details:before.moderation_details});
  assert.equal((await db.query('select count(*)::int n from ad_image_fingerprints where ad_id=$1',[held])).rows[0].n,1);
  await db.query("select record_ad_safety_scan($1,'passed',null)",[held]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[held])).rows[0].moderation_status,'approved');
});

test('review_similar clearance approves only when safety already passed', async () => {
  const source=await addAd(alice,'review-clear-similar-source');
  await scan(source,'e2'.repeat(32),'3141592653589793');
  const held=await addAd(bob,'review-clear-similar-target');
  assert.equal((await scan(held,'e3'.repeat(32),'3141592653589793')).status,'review_similar');
  await db.query("select record_ad_safety_scan($1,'passed',null)",[held]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[held])).rows[0].moderation_status,'pending_scan');
  await resolveReview(held,'clear','moderator-bea','Shared template collision confirmed legitimate');
  assert.equal((await db.query('select moderation_status from ads where id=$1',[held])).rows[0].moderation_status,'approved');
  const audit=(await db.query(`select matched_ad_id,previous_duplicate_status,decision,
    reviewer_identity,reason,created_at is not null as has_created_at
    from ad_duplicate_review_decisions where ad_id=$1`,[held])).rows[0];
  assert.deepEqual(audit,{matched_ad_id:source,previous_duplicate_status:'review_similar',decision:'clear',
    reviewer_identity:'moderator-bea',reason:'Shared template collision confirmed legitimate',has_created_at:true});
});

test('clearance cannot override held or failed safety results', async () => {
  for (const [suffix,safety,expected] of [['held','held','pending_scan'],['failed','failed','rejected']]) {
    const source=await addAd(alice,`safety-${suffix}-source`);
    await scan(source,suffix==='held'?'e4'.repeat(32):'e5'.repeat(32),suffix==='held'?'4242424242424242':'5151515151515151');
    const held=await addAd(bob,`safety-${suffix}-target`);
    await scan(held,suffix==='held'?'e4'.repeat(32):'e5'.repeat(32),'abcdefabcdefabcd');
    await db.query('select record_ad_safety_scan($1,$2,$3)',[held,safety,'Safety review result']);
    await resolveReview(held,'clear','moderator-cam','Duplicate match is legitimate shared material');
    assert.deepEqual((await db.query('select moderation_status,safety_status,duplicate_status from ads where id=$1',[held])).rows[0],
      {moderation_status:expected,safety_status:safety,duplicate_status:'passed'});
  }
});

test('duplicate rejection remains unpublished and cannot be overwritten', async () => {
  const source=await addAd(alice,'review-reject-source');
  await scan(source,'e6'.repeat(32),'6161616161616161');
  const held=await addAd(bob,'review-reject-target');
  await scan(held,'e6'.repeat(32),'7171717171717171');
  await db.query("select record_ad_safety_scan($1,'passed',null)",[held]);
  assert.deepEqual(await resolveReview(held,'reject','moderator-dev','Submission is not eligible after human review'),
    {status:'rejected',decision:'reject',matched_ad_id:source});
  assert.deepEqual((await db.query('select moderation_status,duplicate_status from ads where id=$1',[held])).rows[0],
    {moderation_status:'rejected',duplicate_status:'rejected'});
  await assert.rejects(resolveReview(held,'clear','moderator-two','A later attempt must not replace the first'),/ALREADY_RESOLVED/);
  assert.deepEqual((await db.query('select decision,reviewer_identity,count(*) over()::int n from ad_duplicate_review_decisions where ad_id=$1',[held])).rows[0],
    {decision:'reject',reviewer_identity:'moderator-dev',n:1});
});

test('browser roles cannot resolve holds or mutate duplicate review audits', async () => {
  const source=await addAd(alice,'browser-review-source');
  await scan(source,'e7'.repeat(32),'7272727272727272');
  const held=await addAd(bob,'browser-review-target');
  await scan(held,'e7'.repeat(32),'7373737373737373');
  await db.exec('set role authenticated');
  try {
    await assert.rejects(resolveReview(held,'clear','browser-user','Browser must not resolve this review'),/permission denied/);
    await assert.rejects(db.query(`insert into ad_duplicate_review_decisions
      (ad_id,matched_ad_id,previous_duplicate_status,decision,reviewer_identity,reason)
      values($1,$2,'review_identical','clear','browser-user','Browser must not write audit')`,[held,source]),/permission denied/);
    await assert.rejects(db.query("update ad_duplicate_review_decisions set reason='Browser overwrite attempt' where ad_id=$1",[held]),/permission denied/);
    await assert.rejects(db.query('delete from ad_duplicate_review_decisions where ad_id=$1',[held]),/permission denied/);
  } finally {
    await db.exec('reset role');
  }
  assert.equal((await db.query('select duplicate_status from ads where id=$1',[held])).rows[0].duplicate_status,'review_identical');
});

test('resolution refuses non-held and removed ads', async () => {
  const pending=await addAd(alice,'review-pending');
  await assert.rejects(resolveReview(pending,'clear'),/NOT_HELD/);
  const passed=await addAd(alice,'review-passed');
  await scan(passed,'e8'.repeat(32),'8181818181818181');
  await assert.rejects(resolveReview(passed,'clear'),/NOT_HELD/);
  const sameOwner=await addAd(alice,'review-same-owner');
  await scan(sameOwner,'e8'.repeat(32),'8282828282828282');
  await assert.rejects(resolveReview(sameOwner,'clear'),/NOT_HELD/);

  const source=await addAd(alice,'review-removed-source');
  await scan(source,'e9'.repeat(32),'9191919191919191');
  const removed=await addAd(bob,'review-removed-target');
  await scan(removed,'e9'.repeat(32),'9292929292929292');
  await db.query("update ads set moderation_status='removed' where id=$1",[removed]);
  await assert.rejects(resolveReview(removed,'clear'),/REMOVED_AD/);
});

test('cross-creator exact copies affect only duplicate status and clear without a safety hold', async () => {
  const source=await addAd(alice,'separation-exact-source');
  await scan(source,'f1'.repeat(32),'a1b2c3d4e5f60718');
  const copy=await addAd(bob,'separation-exact-copy');
  assert.equal((await scan(copy,'f1'.repeat(32),'1827364554637281')).status,'review_identical');
  await db.query("select record_ad_safety_scan($1,'passed',null)",[copy]);
  assert.deepEqual((await db.query('select safety_status,duplicate_status,moderation_status from ads where id=$1',[copy])).rows[0],
    {safety_status:'passed',duplicate_status:'review_identical',moderation_status:'pending_scan'});
  await resolveReview(copy,'clear','moderator-separation','Permission for the shared image was confirmed');
  assert.deepEqual((await db.query('select safety_status,duplicate_status,moderation_status from ads where id=$1',[copy])).rows[0],
    {safety_status:'passed',duplicate_status:'passed',moderation_status:'approved'});
});

test('genuine safety holds and failures remain independent of duplicate clearance', async () => {
  const held=await addAd(alice,'separation-safety-hold');
  await scan(held,'f2'.repeat(32),'b1c2d3e4f5061728');
  await db.query("select record_ad_safety_scan($1,'held','Regulated claim requires human review')",[held]);
  assert.deepEqual((await db.query('select safety_status,duplicate_status,moderation_status from ads where id=$1',[held])).rows[0],
    {safety_status:'held',duplicate_status:'passed',moderation_status:'pending_scan'});

  const source=await addAd(alice,'separation-reject-source');
  await scan(source,'f3'.repeat(32),'c1d2e3f405162738');
  const copy=await addAd(bob,'separation-reject-copy');
  await scan(copy,'f3'.repeat(32),'3847561029384756');
  await resolveReview(copy,'clear','moderator-separation','The shared source material is legitimate');
  await db.query("select record_ad_safety_scan($1,'failed','Independent safety violation')",[copy]);
  assert.deepEqual((await db.query('select safety_status,duplicate_status,moderation_status from ads where id=$1',[copy])).rows[0],
    {safety_status:'failed',duplicate_status:'passed',moderation_status:'rejected'});
});

test('browser read APIs expose fixed public and owner-safe columns only', async () => {
  const source=await addAd(alice,'safe-read-source');
  await scan(source,'f4'.repeat(32),'1234432112344321');
  const cleared=await addAd(bob,'safe-read-cleared-match');
  await scan(cleared,'f4'.repeat(32),'5678876556788765');
  await resolveReview(cleared,'clear','moderator-safe-read','Shared image permission was reviewed and confirmed');
  await db.query("select record_ad_safety_scan($1,'passed','Safe for publication')",[cleared]);
  assert.equal((await db.query('select moderation_status from ads where id=$1',[cleared])).rows[0].moderation_status,'approved');

  await db.exec('set role anon');
  try {
    await assert.rejects(db.query('select * from public.ads'),/permission denied/);
    const publicRows=(await db.query('select * from public.get_public_ads()')).rows;
    assert.ok(publicRows.some(ad=>ad.id===cleared));
    assert.ok(publicRows.every(ad=>ad.moderation_status==='approved'));
    assert.deepEqual(Object.keys(publicRows.find(ad=>ad.id===cleared)).sort(),[
      'caption','created_at','id','image_url','moderation_status','support_total','title','user_id',
    ]);
    await assert.rejects(db.query('select * from public.get_my_ads()'),/permission denied/);
    await assert.rejects(db.query('select duplicate_status from public.get_public_ads()'),/does not exist/);
  } finally {
    await db.exec('reset role');
  }

  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[alice]);
  await db.exec('set role authenticated');
  try {
    await assert.rejects(db.query('select * from public.ads'),/permission denied/);
    const publicMatch=(await db.query('select * from public.get_public_ads() where id=$1',[cleared])).rows[0];
    assert.equal(publicMatch.title,'safe-read-cleared-match');
    assert.equal((await db.query('select count(*)::int n from public.get_my_ads() where id=$1',[cleared])).rows[0].n,0);
    await db.query(`insert into public.ads(user_id,title,image_url,image_storage_path)
      values($1::uuid,'owner-browser-insert','https://example.invalid/owner.png',$1::text||'/owner.png')`,[alice]);
  } finally {
    await db.exec('reset role');
  }

  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[bob]);
  await db.exec('set role authenticated');
  try {
    const ownerMatch=(await db.query('select * from public.get_my_ads() where id=$1',[cleared])).rows[0];
    assert.deepEqual(Object.keys(ownerMatch).sort(),[
      'caption','created_at','duplicate_of_ad_id','duplicate_status','id','image_url',
      'moderation_status','support_total','title','user_id',
    ]);
    assert.equal(ownerMatch.duplicate_status,'passed');
    assert.equal(ownerMatch.duplicate_of_ad_id,source);
    for (const internalColumn of [
      'moderation_details','moderation_risk_score','moderation_scan_version',
      'moderation_image_sha256','moderation_last_error','moderation_attempts',
      'image_storage_path','image_index_required',
    ]) {
      await assert.rejects(db.query(`select ${internalColumn} from public.get_my_ads()`),/does not exist/);
    }
    await assert.rejects(db.query('select * from public.ad_image_fingerprints'),/permission denied/);
    await assert.rejects(db.query('select * from public.ad_duplicate_review_decisions'),/permission denied/);
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub','',false)");
  }

  await db.exec('set role service_role');
  try {
    const authoritative=(await db.query(`select duplicate_status,duplicate_of_ad_id,
      moderation_details,image_storage_path from public.ads where id=$1`,[cleared])).rows[0];
    assert.equal(authoritative.duplicate_status,'passed');
    assert.equal(authoritative.duplicate_of_ad_id,source);
    assert.ok(authoritative.moderation_details.duplicate_check);
  } finally {
    await db.exec('reset role');
  }
});

test('attribution schema uses an owner-saved handle and reports missing profiles', async () => {
  await db.query('insert into creator_profiles(user_id,handle) values($1,$2)',[alice,'alice_art']);
  assert.equal((await db.query('select handle from creator_profiles where user_id=$1',[alice])).rows[0].handle,'alice_art');
  assert.equal((await db.query('select count(*)::int as n from creator_profiles where user_id=$1',[bob])).rows[0].n,0);
});

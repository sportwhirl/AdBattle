import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const claimLeaseMigration = read('../supabase/migrations/20260924015352_safety_scan_claim_lease.sql');
const owner = '00000000-0000-4000-8000-000000000001';
const tokenA = '10000000-0000-4000-8000-000000000001';
const tokenB = '20000000-0000-4000-8000-000000000002';
const scanVersion = 'claim-lease-test-v1';
let db;

async function addAd(title) {
  return (await db.query(`insert into ads(user_id,title,image_url,image_storage_path)
    values($1,$2,'',$2||'.png') returning id`, [owner,title])).rows[0].id;
}

async function claim(adId, token) {
  return (await db.query(
    'select claim_ad_safety_scan($1,$2,$3) result',
    [adId,token,scanVersion],
  )).rows[0].result;
}

async function finalize(adId, token, {
  status = 'passed', reason = null, risk = 7,
  hash = 'ab'.repeat(32), details = { moderation: { flagged: false } },
} = {}) {
  return (await db.query(
    `select finalize_ad_safety_scan($1,$2,$3,$4,$5,$6,$7,$8) result`,
    [adId,token,status,reason,risk,hash,details,scanVersion],
  )).rows[0].result;
}

before(async () => {
  db = new PGlite();
  await db.exec(`create schema auth;
    create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.exec(read('../supabase/staging/00_test_base.sql'));
  await db.query('insert into auth.users values($1)',[owner]);
  await db.exec(read('../supabase/migrations/20260922_duplicate_screening.sql'));
  await db.exec(claimLeaseMigration);
});

after(async () => db?.close());

test('simultaneous claimers produce one lease holder and one busy result', async () => {
  const ad = await addAd('concurrent-claim');
  const results = await Promise.all([claim(ad,tokenA),claim(ad,tokenB)]);
  assert.deepEqual(results.map(({ result }) => result).sort(),['busy','claimed']);
  const winner = results[0].result === 'claimed' ? tokenA : tokenB;
  const row = (await db.query(`select safety_scan_claim_token::text token,
    moderation_attempts,safety_status from ads where id=$1`,[ad])).rows[0];
  assert.deepEqual(row,{token:winner,moderation_attempts:1,safety_status:'pending'});

  const replay = await claim(ad,winner);
  assert.equal(replay.result,'claimed');
  assert.equal(replay.replayed,true);
  assert.equal((await db.query('select moderation_attempts from ads where id=$1',[ad])).rows[0].moderation_attempts,1);
});

test('an expired lease is recovered and the fenced-out token cannot mutate state', async () => {
  const ad = await addAd('stale-lease');
  assert.equal((await claim(ad,tokenA)).result,'claimed');
  await db.query(`update ads set safety_scan_lease_expires_at=clock_timestamp()-interval '1 second'
    where id=$1`,[ad]);

  const recovered = await claim(ad,tokenB);
  assert.equal(recovered.result,'claimed');
  assert.equal(recovered.recovered_stale,true);
  assert.equal((await db.query('select moderation_attempts from ads where id=$1',[ad])).rows[0].moderation_attempts,2);

  await assert.rejects(finalize(ad,tokenA,{ status:'failed', reason:'stale worker' }),/SAFETY_SCAN_CLAIM_LOST/);
  const staleFailure = (await db.query(
    'select record_ad_safety_scan_failure($1,$2,$3,$4) result',
    [ad,tokenA,'stale worker failed',scanVersion],
  )).rows[0].result;
  assert.equal(staleFailure.result,'claim_lost');
  assert.deepEqual((await db.query(`select safety_status,moderation_reason,
    moderation_risk_score,moderation_last_error,safety_scan_claim_token::text token
    from ads where id=$1`,[ad])).rows[0],{
    safety_status:'pending',moderation_reason:null,moderation_risk_score:null,
    moderation_last_error:null,token:tokenB,
  });
  assert.equal((await db.query(`select count(*)::int n from moderation_events
    where ad_id=$1 and stage='error'`,[ad])).rows[0].n,0);

  assert.equal((await finalize(ad,tokenB)).result,'finalized');
});

test('a claimed scanner failure releases its lease and permits a fresh claim', async () => {
  const ad = await addAd('released-after-scanner-error');
  assert.equal((await claim(ad,tokenA)).result,'claimed');

  const failure = (await db.query(
    'select record_ad_safety_scan_failure($1,$2,$3,$4) result',
    [ad,tokenA,'temporary provider outage',scanVersion],
  )).rows[0].result;
  assert.deepEqual(failure,{result:'released'});

  const released = (await db.query(`select safety_status,
    safety_scan_claim_token::text token,safety_scan_claimed_at,
    safety_scan_lease_expires_at,moderation_last_error,
    moderation_scan_version,moderation_attempts
    from ads where id=$1`,[ad])).rows[0];
  assert.deepEqual(released,{
    safety_status:'pending',token:null,safety_scan_claimed_at:null,
    safety_scan_lease_expires_at:null,
    moderation_last_error:'temporary provider outage',
    moderation_scan_version:scanVersion,moderation_attempts:1,
  });

  const audits = (await db.query(`select stage,outcome,reason,details
    from moderation_events where ad_id=$1 and stage='error'`,[ad])).rows;
  assert.deepEqual(audits,[{
    stage:'error',outcome:'temporary_error',
    reason:'temporary provider outage',details:null,
  }]);

  const reclaimed = await claim(ad,tokenB);
  assert.equal(reclaimed.result,'claimed');
  assert.equal(reclaimed.replayed,false);
  assert.equal(reclaimed.recovered_stale,false);
  assert.deepEqual((await db.query(`select safety_status,
    safety_scan_claim_token::text token,moderation_attempts,
    moderation_last_error from ads where id=$1`,[ad])).rows[0],{
    safety_status:'pending',token:tokenB,moderation_attempts:2,
    moderation_last_error:null,
  });
});

test('finalization is atomic, exact-replayable after a lost response, and preserves duplicate evidence', async () => {
  const ad = await addAd('lost-finalize-response');
  await db.query('select record_ad_duplicate_scan($1,$2,$3,$4)',[
    ad,'cd'.repeat(32),'0123456789abcdef','dhash-9x8-luma-v1',
  ]);
  await db.query(`update ads set moderation_details = moderation_details
    || '{"stale_legacy":true}'::jsonb where id=$1`,[ad]);
  await assert.rejects(
    db.query(`update ads set moderation_details='{"stale_legacy":true}'::jsonb
      where id=$1`,[ad]),
    /DUPLICATE_SCAN_EVIDENCE_IMMUTABLE/,
  );
  await db.query(`update ads set promotion_stopped_at='2026-09-24T00:00:00Z' where id=$1`,[ad]);
  await claim(ad,tokenA);
  const input = {
    status:'passed', reason:null, risk:11, hash:'cd'.repeat(32),
    details:{ scanner_version:scanVersion, moderation:{ flagged:false } },
  };

  const committed = await finalize(ad,tokenA,input);
  assert.deepEqual(committed,{
    result:'finalized',safety_status:'passed',moderation_status:'approved',
  });

  // Model a committed transaction whose HTTP response never reached the worker.
  const replayed = await finalize(ad,tokenA,input);
  assert.deepEqual(replayed,{
    result:'replayed',safety_status:'passed',moderation_status:'approved',
  });
  const row = (await db.query(`select safety_status,moderation_status,
    moderation_reason,moderation_risk_score,moderation_image_sha256,
    moderation_details,promotion_stopped_at,safety_scan_lease_expires_at
    from ads where id=$1`,[ad])).rows[0];
  assert.equal(row.safety_status,'passed');
  assert.equal(row.moderation_status,'approved');
  assert.equal(row.moderation_risk_score,11);
  assert.equal(row.moderation_image_sha256,'cd'.repeat(32));
  assert.ok(row.moderation_details.duplicate_check);
  assert.deepEqual(row.moderation_details.moderation,{flagged:false});
  assert.equal(row.moderation_details.stale_legacy,undefined);
  assert.ok(row.promotion_stopped_at);
  assert.equal(row.safety_scan_lease_expires_at,null);
  assert.equal((await db.query(`select count(*)::int n from moderation_events
    where ad_id=$1 and stage='final_decision'`,[ad])).rows[0].n,1);

  // A late legacy safety worker performs a whole-column write. Even when its
  // safety payload matches, it must not erase or replace duplicate evidence.
  await assert.rejects(
    db.query('update ads set moderation_details=$2 where id=$1',[ad,input.details]),
    /DUPLICATE_SCAN_EVIDENCE_IMMUTABLE/,
  );
  await assert.rejects(
    db.query(`update ads set moderation_details=jsonb_set(
      moderation_details,'{duplicate_check,status}','"review_similar"') where id=$1`,[ad]),
    /DUPLICATE_SCAN_EVIDENCE_IMMUTABLE/,
  );

  await assert.rejects(
    finalize(ad,tokenA,{...input,risk:12}),
    /SAFETY_FINALIZATION_CONFLICT/,
  );
});

test('an audit insert failure rolls back the terminal state and all evidence', async () => {
  const ad = await addAd('atomic-finalize-rollback');
  await claim(ad,tokenA);
  await db.exec(`create function fail_final_audit() returns trigger language plpgsql as $$
    begin
      if new.stage='final_decision' then raise exception 'TEST_FINAL_AUDIT_FAILURE'; end if;
      return new;
    end $$;
    create trigger fail_final_audit before insert on moderation_events
      for each row execute function fail_final_audit();`);
  try {
    await assert.rejects(finalize(ad,tokenA),/TEST_FINAL_AUDIT_FAILURE/);
  } finally {
    await db.exec(`drop trigger fail_final_audit on moderation_events;
      drop function fail_final_audit();`);
  }
  const row = (await db.query(`select safety_status,moderation_status,
    moderation_reason,moderation_details,moderation_risk_score,
    moderation_image_sha256,safety_scan_final_payload,safety_scan_final_result,
    safety_scan_claim_token::text token
    from ads where id=$1`,[ad])).rows[0];
  assert.deepEqual(row,{
    safety_status:'pending',moderation_status:'pending_scan',
    moderation_reason:null,moderation_details:null,moderation_risk_score:null,
    moderation_image_sha256:null,safety_scan_final_payload:null,
    safety_scan_final_result:null,token:tokenA,
  });
  assert.equal((await db.query(`select count(*)::int n from moderation_events
    where ad_id=$1 and stage='final_decision'`,[ad])).rows[0].n,0);
});

test('passed and held finalizations require an image hash while failed may omit it', async () => {
  for (const status of ['passed','held']) {
    const ad = await addAd(`missing-${status}-hash`);
    await claim(ad,tokenA);
    await assert.rejects(
      finalize(ad,tokenA,{ status,hash:null }),
      /INVALID_SAFETY_SCAN_FINALIZATION/,
    );
    assert.deepEqual((await db.query(`select safety_status,
      safety_scan_final_payload from ads where id=$1`,[ad])).rows[0],{
      safety_status:'pending',safety_scan_final_payload:null,
    });
  }

  const failedAd = await addAd('failed-without-hash');
  await claim(failedAd,tokenA);
  assert.equal((await finalize(failedAd,tokenA,{
    status:'failed',reason:'invalid source image',hash:null,
  })).safety_status,'failed');
});

test('committed safety evidence fences legacy direct writes while duplicate scan remains independent', async () => {
  const ad = await addAd('legacy-worker-fence');
  await claim(ad,tokenA);
  await finalize(ad,tokenA,{
    details:{ scanner_version:scanVersion, moderation:{ flagged:false } },
  });

  await assert.rejects(
    db.query(`update ads set moderation_reason='late legacy decision',
      moderation_details='{"legacy":true}',moderation_risk_score=99,
      moderation_last_error='late legacy error' where id=$1`,[ad]),
    /FINALIZED_SAFETY_EVIDENCE_IMMUTABLE/,
  );
  await assert.rejects(
    db.query('update ads set promotion_stopped_at=clock_timestamp() where id=$1',[ad]),
    /FINALIZED_SAFETY_PROMOTION_STATE_IMMUTABLE/,
  );

  await db.query('select record_ad_duplicate_scan($1,$2,$3,$4)',[
    ad,'ef'.repeat(32),'fedcba9876543210','dhash-9x8-luma-v1',
  ]);
  await assert.rejects(
    db.query(`update ads
      set moderation_details=moderation_details-'duplicate_check'
      where id=$1`,[ad]),
    /DUPLICATE_SCAN_EVIDENCE_IMMUTABLE/,
  );
  const row = (await db.query(`select safety_status,duplicate_status,
    moderation_status,moderation_details from ads where id=$1`,[ad])).rows[0];
  assert.equal(row.safety_status,'passed');
  assert.equal(row.duplicate_status,'passed');
  assert.equal(row.moderation_status,'approved');
  assert.deepEqual(row.moderation_details.moderation,{flagged:false});
  assert.ok(row.moderation_details.duplicate_check);
});

test('browser inserts cannot forge leases and all lease RPCs remain service-only', async () => {
  await db.exec(`set request.jwt.claim.sub='${owner}'; set role authenticated`);
  try {
    await db.query(`insert into ads(user_id,title,image_url,image_storage_path,
      moderation_reason,moderation_details,moderation_risk_score,
      moderation_scan_version,moderation_image_sha256,moderation_last_error,
      moderation_attempts,moderation_last_attempt_at,moderated_at,promotion_stopped_at,
      safety_scan_claim_token,safety_scan_claimed_at,safety_scan_lease_expires_at,
      safety_scan_final_payload,safety_scan_final_result)
      values($1,'forged-lease','','forged.png','forged','{"forged":true}',100,
        'forged-version',$3,'forged error',2147483647,clock_timestamp(),
        clock_timestamp(),clock_timestamp(),$2,clock_timestamp(),
        clock_timestamp()+interval '1 year','{}','{}')`,[owner,tokenA,'ff'.repeat(32)]);
    await assert.rejects(
      db.query('select claim_ad_safety_scan(1,$1,$2)',[tokenA,scanVersion]),
      /permission denied/,
    );
    await assert.rejects(
      db.query(`select finalize_ad_safety_scan(1,$1,'passed',null,0,null,'{}',$2)`,[tokenA,scanVersion]),
      /permission denied/,
    );
    await assert.rejects(
      db.query('select record_ad_safety_scan_failure(1,$1,$2,$3)',[tokenA,'error',scanVersion]),
      /permission denied/,
    );
  } finally {
    await db.exec('reset role');
  }

  const row = (await db.query(`select safety_scan_claim_token,
    safety_scan_claimed_at,safety_scan_lease_expires_at,
    safety_scan_final_payload,safety_scan_final_result,
    moderation_reason,moderation_details,moderation_risk_score,
    moderation_scan_version,moderation_image_sha256,moderation_last_error,
    moderation_attempts,moderation_last_attempt_at,moderated_at,promotion_stopped_at,id
    from ads where title='forged-lease'`)).rows[0];
  const forgedAdId = row.id;
  delete row.id;
  assert.deepEqual(row,{
    safety_scan_claim_token:null,safety_scan_claimed_at:null,
    safety_scan_lease_expires_at:null,safety_scan_final_payload:null,
    safety_scan_final_result:null,
    moderation_reason:null,moderation_details:null,moderation_risk_score:null,
    moderation_scan_version:null,moderation_image_sha256:null,
    moderation_last_error:null,moderation_attempts:0,
    moderation_last_attempt_at:null,moderated_at:null,promotion_stopped_at:null,
  });

  assert.equal((await claim(forgedAdId,tokenB)).result,'claimed');
  assert.equal((await db.query('select moderation_attempts from ads where id=$1',[forgedAdId])).rows[0].moderation_attempts,1);

  await db.exec('set role service_role');
  try {
    await assert.rejects(
      db.query("select record_ad_safety_scan(1,'passed',null)"),
      /permission denied/,
    );
  } finally {
    await db.exec('reset role');
  }
});

test('claim lease time is captured only after the row lock is acquired', async () => {
  const definition = claimLeaseMigration.slice(
    claimLeaseMigration.indexOf('create function public.claim_ad_safety_scan'),
    claimLeaseMigration.indexOf('create function public.finalize_ad_safety_scan'),
  ).toLowerCase();
  const rowLock = definition.indexOf('for update');
  const clockCapture = definition.indexOf('claimed_at := clock_timestamp()',rowLock);
  assert.ok(rowLock >= 0 && clockCapture > rowLock);
  assert.doesNotMatch(definition,/claimed_at timestamptz\s*:=\s*clock_timestamp\(\)/i);
});

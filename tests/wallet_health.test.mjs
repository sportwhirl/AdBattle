import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const reportSql = readFileSync(new URL('../supabase/staging/check_wallet_health.sql', import.meta.url), 'utf8');
const db = new PGlite();
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const check = async () => (await db.query(reportSql)).rows[0];
const finding = (report, name) => {
  const row = report.checks.find(c => c.check === name);
  assert.ok(row, `missing check: ${name}`);
  return row;
};
const tables = ['wallets','wallet_transactions','wallet_topups','supports','ad_settlement_state',
  'support_settlements','wallet_transfer_guards','wallet_payment_risks','wallet_payment_risk_events',
  'creator_accounts','cron.job','cron.job_run_details'];
const snapshot = async () => Promise.all(tables.map(async table =>
  (await db.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`)).rows));

async function support(amount) {
  await db.query('select spend_wallet_support($1,1,$2,gen_random_uuid())', [owner, amount]);
}
async function claim() {
  const [{ settlement_id: id }] = (await db.query('select * from claim_due_wallet_settlements(1)')).rows;
  await db.query('select prepare_wallet_transfer($1)', [id]);
  return id;
}
async function pendingSettlement() {
  await db.query('select record_wallet_topup($1,$2,$3,10000)', ['cs_pending','pi_pending',owner]);
  await support(2500);
  return claim();
}
async function scenario(setup, verify) {
  await db.exec('begin');
  try {
    await setup();
    const before = await snapshot();
    await verify(await check());
    assert.deepEqual(await snapshot(), before, 'report changed fixture state');
  } finally { await db.exec('rollback'); }
}

before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create role health_reader;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
  `);
  await db.exec(readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url), 'utf8'));
  for (const file of ['20260920_wallet_ledger.sql','20260921_wallet_safety.sql',
    '20260922_wallet_capability_recovery.sql','20260923_wallet_balance_recovery.sql',
    '20260923_wallet_table_privileges.sql']) {
    await db.exec(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8')
      .replace('create extension if not exists pgcrypto;', ''));
  }
  // Inert extension-shaped tables: no pg_cron/pg_net worker or HTTP call exists
  // in this fixture. Secret/error sentinels must never appear in the report.
  await db.exec(`create schema cron;
    create table cron.job(jobid bigint primary key,jobname text,active boolean,schedule text,command text);
    create table cron.job_run_details(jobid bigint,runid bigint,status text,start_time timestamptz,
      end_time timestamptz,return_message text);
    insert into cron.job values(1,'adbattle-wallet-settlement',true,'* * * * *','SECRET_JOB_SENTINEL');
    insert into cron.job_run_details values(1,1,'succeeded',now()-interval '1 minute',
      now()-interval '59 seconds','SECRET_ERROR_SENTINEL');
  `);
  await db.query('insert into auth.users values ($1),($2)', [owner,other]);
  await db.query(`insert into ads(user_id,title,image_url,moderation_status)
    values ($1,'Health fixture','https://example.invalid/test.png','approved')`, [owner]);
  await db.query(`insert into creator_accounts(user_id,stripe_account_id,onboarding_complete,charges_enabled,payouts_enabled)
    values ($1,'acct_health',true,true,true)`, [owner]);
  for (let i=1;i<=3;i++) await db.query('select record_wallet_topup($1,$2,$3,1000)', [`cs_${i}`,`pi_${i}`,owner]);
  for (const [amount, transfer] of [[1000,'tr_health_one'],[1500,'tr_health_two']]) {
    await support(amount);
    await db.query('select complete_wallet_settlement($1,$2)', [await claim(),transfer]);
  }
  await db.query(`select record_wallet_payment_risk('pi_2',$1,200,false,'evt_refund','charge.refunded')`, [owner]);
  // Fixture-only operator reconciliation, mirroring the completed staging case.
  await db.exec("update wallet_payment_risks set resolved_at=now(); update wallets set status='active'");
});
after(() => db.close());

test('healthy populated report executes READ ONLY, keeps state unchanged and redacts inputs', async () => {
  const before = await snapshot();
  await db.exec('begin read only');
  try {
    const report = await check();
    assert.equal(report.health_status, 'HEALTHY');
    assert.equal(Number(report.nonpassing_checks), 0);
    assert.equal(Number(report.checks_total), 29);
    assert.equal(report.wallet_summary.wallet_liability_cents, 300);
    assert.equal(report.wallet_summary.wallet_debt_cents, 0);
    assert.equal(report.wallet_summary.unfinished_settlements, 0);
    assert.equal(report.wallet_summary.global_payment_risk_hold, false);
    assert.equal(report.scheduler_summary.latest_completed_run.status, 'succeeded');
    assert.match(report.scope, /no Stripe balance, HTTP delivery/);
    for (const secret of ['SECRET_JOB_SENTINEL','SECRET_ERROR_SENTINEL','pi_2','acct_health',owner]) {
      assert.ok(!JSON.stringify(report).includes(secret), `unexpected sensitive output: ${secret}`);
    }
    assert.deepEqual(await snapshot(), before);
  } finally { await db.exec('rollback'); }
});

test('detects balance/lifetime drift, orphan ledger rows, and legitimate negative debt', async () => {
  for (const [sql, name] of [
    ['update wallets set available_cents=301','wallet_ledger_balance'],
    ['update wallets set lifetime_topup_cents=lifetime_topup_cents+1','wallet_lifetime_totals'],
    ['update wallets set lifetime_support_cents=lifetime_support_cents+1','wallet_lifetime_totals'],
    ['delete from wallets','wallet_ledger_balance'],
  ]) await scenario(() => db.exec(sql), report => {
    assert.equal(report.health_status,'ATTENTION');
    assert.equal(finding(report,name).status,'FAIL');
    assert.equal(finding(report,name).affected_count,1);
  });
  await scenario(async () => {
    await db.exec(`update wallets set available_cents=-100,status='frozen';
      insert into wallet_transactions(user_id,entry_type,amount_cents,balance_after_cents)
        values('${owner}','adjustment',-400,-100)`);
  }, report => {
    assert.equal(finding(report,'wallet_ledger_balance').status,'PASS');
    assert.equal(finding(report,'wallet_lifetime_totals').status,'PASS');
    assert.equal(finding(report,'negative_wallet_balances').status,'WARN');
    assert.equal(report.wallet_summary.wallet_debt_cents,100);
    assert.equal(report.wallet_summary.wallet_liability_cents,0);
  });
});

test('unresolved risks and frozen wallets remain visible without being cleared', async () => {
  await scenario(() => db.query(`select record_wallet_payment_risk('pi_1',$1,0,true,'evt_dispute','charge.dispute.created')`,[owner]), report => {
    assert.equal(finding(report,'unresolved_payment_risks').affected_count,1);
    assert.equal(finding(report,'frozen_wallets').affected_count,1);
    assert.equal(finding(report,'risk_wallet_hold_consistency').status,'PASS');
    assert.equal(finding(report,'wallet_ledger_balance').status,'PASS');
    assert.equal(report.wallet_summary.global_payment_risk_hold,true);
  });
  await scenario(() => db.exec('update wallet_payment_risks set resolved_at=null'), report => {
    assert.equal(finding(report,'risk_wallet_hold_consistency').status,'FAIL');
  });
  await scenario(() => db.exec("update wallets set status='frozen'"), report => {
    assert.equal(finding(report,'frozen_wallets').status,'WARN');
    assert.equal(report.wallet_summary.global_payment_risk_hold,false);
  });
});

test('fresh processing is healthy; stale, retrying, manual and expired transfers need attention', async () => {
  await scenario(pendingSettlement, report => {
    assert.equal(report.health_status,'HEALTHY');
    assert.equal(report.wallet_summary.unfinished_settlements,1);
  });
  for (const [sql, name] of [
    ["update support_settlements set updated_at=now()-interval '16 minutes' where status='processing'",'stale_processing_settlements'],
    ["update wallet_transfer_guards set manual_review=true where settlement_id in(select id from support_settlements where status<>'succeeded')",'manual_review_settlements'],
    ["update wallet_transfer_guards set first_attempt_at=now()-interval '21 hours' where settlement_id in(select id from support_settlements where status<>'succeeded')",'expired_transfer_retry_windows'],
    ["update support_settlements set status='retry',next_attempt_at=now()-interval '6 minutes' where status='processing'",'overdue_retries'],
    ["update support_settlements set status='retry',next_attempt_at=null where status='processing'",'overdue_retries'],
  ]) await scenario(async () => { await pendingSettlement(); await db.exec(sql); }, report => {
    assert.equal(report.health_status,'ATTENTION');
    assert.equal(finding(report,name).affected_count,1);
  });
  await scenario(async () => {
    const id=await pendingSettlement();
    await db.query('select retry_wallet_settlement($1,$2)',[id,'SECRET_WORKER_ERROR']);
  }, report => {
    assert.equal(finding(report,'retrying_settlements').status,'WARN');
    assert.equal(finding(report,'overdue_retries').status,'PASS');
    assert.ok(!JSON.stringify(report).includes('SECRET_WORKER_ERROR'));
  });
});

test('detects missing guards, changed destinations, broken pointers and false completion', async () => {
  for (const [sql,name] of [
    ["delete from wallet_transfer_guards where settlement_id in(select id from support_settlements where status<>'succeeded')",'unfinished_settlement_integrity'],
    ["update ad_settlement_state set active_settlement_id=null",'unfinished_settlement_integrity'],
    ["update creator_accounts set stripe_account_id='acct_changed'",'changed_transfer_destinations'],
    ["update support_settlements set stripe_transfer_id='tr_invalid' where status='processing'",'completed_settlement_integrity'],
    ["update support_settlements set status='succeeded' where status='processing'",'completed_settlement_integrity'],
    [`update ad_settlement_state set creator_user_id='${other}'`,'active_settlement_pointers'],
  ]) await scenario(async () => { await pendingSettlement(); await db.exec(sql); }, report => {
    assert.equal(report.health_status,'ATTENTION');
    assert.notEqual(finding(report,name).status,'PASS');
  });
  await scenario(() => db.exec("update support_settlements set completed_at=null where stripe_transfer_id='tr_health_one'"), report => {
    assert.equal(finding(report,'completed_settlement_integrity').status,'FAIL');
  });
});

test('unclaimed threshold/inactivity batches respect grace periods and stored creator readiness', async () => {
  for (const [amount, age, due, ready] of [
    [2500,'4 minutes',false,true], [2500,'6 minutes',true,true],
    [1000,'24 hours 4 minutes',false,true], [1000,'24 hours 6 minutes',true,true],
    [999,'25 hours',false,true], [2500,'6 minutes',true,false],
  ]) await scenario(async () => {
    await db.query('select record_wallet_topup($1,$2,$3,10000)',['cs_due','pi_due',owner]);
    await support(amount);
    await db.query('update ad_settlement_state set last_support_at=now()-$1::interval',[age]);
    await db.query('update creator_accounts set payouts_enabled=$1',[ready]);
  }, report => {
    assert.equal(finding(report,'eligible_unclaimed_settlements').affected_count,due&&ready?1:0);
    assert.equal(finding(report,'eligible_creator_not_ready').affected_count,due&&!ready?1:0);
  });
});

test('cron configuration, staleness, failures and absent history never produce false health', async () => {
  const cases = [
    ["delete from cron.job",'scheduler_configuration','FAIL'],
    ["update cron.job set active=false",'scheduler_configuration','FAIL'],
    ["update cron.job set schedule='*/5 * * * *'",'scheduler_configuration','FAIL'],
    ["insert into cron.job select 2,jobname,active,schedule,command from cron.job",'scheduler_configuration','FAIL'],
    ["delete from cron.job_run_details",'scheduler_recent_dispatch','INCOMPLETE'],
    ["update cron.job_run_details set start_time=now()-interval '5 minutes',end_time=now()-interval '4 minutes'",'scheduler_recent_dispatch','FAIL'],
    ["update cron.job_run_details set status='failed'",'scheduler_last_completion','FAIL'],
    ["update cron.job_run_details set start_time=now()+interval '1 minute',end_time=now()+interval '2 minutes'",'scheduler_recent_dispatch','FAIL'],
    ["update cron.job_run_details set status='running',end_time=null",'scheduler_last_completion','INCOMPLETE'],
    ["insert into cron.job_run_details values(1,2,'failed',now()-interval '10 seconds',now()-interval '9 seconds','SECRET_FAILURE')",'scheduler_recent_dispatch','FAIL'],
    ["insert into cron.job_run_details values(1,2,'succeeded',now()-interval '10 seconds',null,null)",'scheduler_recent_dispatch','FAIL'],
    ["insert into cron.job_run_details values(1,2,'running',now()-interval '10 seconds',now()-interval '9 seconds',null)",'scheduler_recent_dispatch','FAIL'],
  ];
  for (const [sql,name,status] of cases) await scenario(() => db.exec(sql), report => {
    assert.notEqual(report.health_status,'HEALTHY',sql);
    assert.equal(finding(report,name).status,status,sql);
    assert.ok(!JSON.stringify(report).includes('SECRET_FAILURE'));
  });
  await scenario(() => db.exec(`update cron.job_run_details set status='failed';
    insert into cron.job_run_details values(1,2,'succeeded',now()-interval '10 seconds',now()-interval '9 seconds',null);
    insert into cron.job_run_details values(1,3,'running',now()-interval '1 second',null,null)`), report => {
    assert.equal(report.health_status,'HEALTHY','a recovered failure and a fresh running job are normal');
  });
  await scenario(() => db.exec(`update cron.job_run_details set start_time=now()-interval '10 minutes',end_time=now()-interval '9 minutes';
    insert into cron.job values(2,'unrelated',true,'* * * * *','SECRET_OTHER_JOB');
    insert into cron.job_run_details values(2,2,'succeeded',now()-interval '10 seconds',now()-interval '9 seconds',null)`), report => {
    assert.equal(finding(report,'scheduler_recent_dispatch').status,'FAIL');
  });
});

test('read-only report is not a repair even when accounting findings exist', async () => {
  await db.exec('begin');
  await db.exec('update wallets set available_cents=available_cents+1');
  await db.exec('commit');
  const before=await snapshot();
  try {
    await db.exec('begin read only');
    assert.equal(finding(await check(),'wallet_ledger_balance').status,'FAIL');
    assert.deepEqual(await snapshot(),before);
  } finally {
    await db.exec('rollback');
    await db.exec('update wallets set available_cents=available_cents-1');
  }
});

test('missing extension tables, schema drift and filtered permissions report INCOMPLETE', async () => {
  for (const [sql,name,state,summary] of [
    ['alter schema cron rename to cron_missing','cron.job','MISSING','scheduler_summary'],
    ['alter table cron.job_run_details rename column status to hidden_status','cron.job_run_details','MISSING_COLUMN','scheduler_summary'],
    ['alter table wallets rename to wallets_missing','public.wallets','MISSING','wallet_summary'],
    ['alter table wallets rename column available_cents to renamed_balance','public.wallets','MISSING_COLUMN','wallet_summary'],
    ['alter table wallets rename to wallets_original; create view wallets as select * from wallets_original',
      'public.wallets','UNSUPPORTED_RELATION','wallet_summary'],
  ]) {
    await db.exec('begin');
    try {
      await db.exec(sql);
      const report=await check();
      assert.equal(report.health_status,'INCOMPLETE');
      assert.equal(report[summary],null);
      assert.equal(finding(report,name+':read_access').note,state);
      if(summary==='wallet_summary') assert.ok(!report.checks.some(c=>c.check==='wallet_ledger_balance'));
    } finally { await db.exec('rollback'); }
  }
  for (const readable of [false,true]) {
    await db.exec('begin');
    try {
      await db.exec('grant usage on schema public,cron to health_reader');
      if(readable) await db.exec('grant select on all tables in schema public,cron to health_reader');
      await db.exec('set role health_reader');
      const report=await check();
      assert.equal(report.health_status,'INCOMPLETE');
      assert.equal(report.wallet_summary,null);
      assert.equal(finding(report,'public.wallets:read_access').note,readable?'RLS_FILTERED':'READ_DENIED');
    } finally { await db.exec('reset role; rollback'); }
  }
});

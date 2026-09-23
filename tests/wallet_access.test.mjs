import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const audit = readFileSync(new URL('../supabase/staging/check_wallet_access.sql', import.meta.url), 'utf8');
const repair = readFileSync(new URL('../supabase/migrations/20260923_wallet_table_privileges.sql', import.meta.url), 'utf8');
const walletTables = ['wallets','wallet_topups','wallet_transactions','ad_settlement_state','support_settlements'];

async function fixture(db, broadDefaults = false) {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.exec(readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url),'utf8'));
  // Model broad hosted defaults for newly created wallet tables. The existing
  // legacy supports table already has its intended grants from the base schema.
  if (broadDefaults) await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role');
  for (const file of ['20260920_wallet_ledger.sql','20260921_wallet_safety.sql',
    '20260922_wallet_capability_recovery.sql','20260923_wallet_balance_recovery.sql']) {
    await db.exec(readFileSync(new URL('../supabase/migrations/'+file, import.meta.url),'utf8')
      .replace('create extension if not exists pgcrypto;',''));
  }
}

test('hosted access runner offline tests', () => {
  execFileSync('python3', [new URL('wallet_access_runner_test.py', import.meta.url).pathname],
    { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
});

test('read-only access audit detects grants, columns, RLS, roles, RPCs and views', async () => {
  const db = new PGlite();
  try {
    await fixture(db);
    await db.exec(repair);
    const check = async () => (await db.query(audit)).rows[0];
    // The audit itself must execute successfully in a READ ONLY transaction.
    await db.exec('begin read only');
    const good = await check();
    await db.exec('rollback');
    assert.equal(good.audit_status,'PASS');
    assert.equal(Number(good.checks_total),178);
    assert.equal(Number(good.nonpassing_checks),0);
    assert.deepEqual(good.findings,[]);
    const cases = [
      ['insert grant','grant insert on wallets to authenticated','table_privilege','authenticated:public.wallets:INSERT'],
      ['column update','grant update(available_cents) on wallets to authenticated','table_privilege','authenticated:public.wallets:UPDATE'],
      ['PUBLIC read','grant select on wallet_payment_risks to public','table_privilege','anon:public.wallet_payment_risks:SELECT'],
      ['truncate grant','grant truncate on wallets to authenticated','table_privilege','authenticated:public.wallets:TRUNCATE'],
      ['disabled RLS','alter table wallets disable row level security','row_security','public.wallets'],
      ['bypass role','alter role authenticated bypassrls','role_bypass','authenticated'],
      ['role inheritance','grant service_role to authenticated','service_role_membership','authenticated'],
      ['client RPC','grant execute on function spend_wallet_support(uuid,bigint,bigint,uuid) to authenticated',
        'function_privilege','authenticated:public.spend_wallet_support(uuid,bigint,bigint,uuid)'],
      ['service bypass','grant execute on function prepare_wallet_transfer_before_recovery(uuid) to service_role',
        'function_privilege','service_role:public.prepare_wallet_transfer_before_recovery(uuid)'],
      ['missing RPC','alter function retry_wallet_settlement(uuid,text) rename to renamed_retry',
        'function_privilege','authenticated:public.retry_wallet_settlement(uuid,text)'],
      ['missing table','alter table wallet_topups rename to renamed_topups','row_security','public.wallet_topups'],
      ['extra overload',"create function spend_wallet_support(text) returns integer language sql as 'select 1'",
        'unexpected_function_overload',null],
      ['view chain',`create view wallet_view as select * from wallets;
        create view wallet_view2 as select * from wallet_view;
        grant select on wallet_view2 to authenticated;`,'dependent_view','authenticated:public.wallet_view2'],
    ];
    for (const [name, sql, category, objectName] of cases) {
      await db.exec('begin');
      try {
        await db.exec(sql);
        const report = await check();
        assert.equal(report.audit_status,'REVIEW_REQUIRED',name);
        assert.ok(report.findings.some(f=>f.category===category && (!objectName || f.object_name===objectName)),name);
      } finally { await db.exec('rollback'); }
    }
    assert.deepEqual(await check(),good);
  } finally { await db.close(); }
});

test('forward repair removes the 15 hosted grants without changing data or server access', async () => {
  const db = new PGlite();
  try {
    await fixture(db, true);
    const check = async () => (await db.query(audit)).rows[0];
    const bad = await check();
    assert.equal(bad.audit_status,'REVIEW_REQUIRED');
    assert.equal(Number(bad.nonpassing_checks),15);
    assert.deepEqual(bad.findings.map(f=>f.object_name).sort(),walletTables.flatMap(t=>
      ['REFERENCES','TRIGGER','TRUNCATE'].map(p=>`authenticated:public.${t}:${p}`)).sort());
    const owner = '00000000-0000-4000-8000-000000000001';
    await db.query('insert into auth.users values ($1)',[owner]);
    await db.query(`insert into ads(user_id,title,image_url,moderation_status)
      values ($1,'Test','https://example.invalid/test.png','approved')`,[owner]);
    await db.query(`insert into creator_accounts(user_id,stripe_account_id,onboarding_complete,charges_enabled,payouts_enabled)
      values ($1,'acct_test',true,true,true)`,[owner]);
    await db.query('select record_wallet_topup($1,$2,$3,1000)',['cs_access','pi_access',owner]);
    await db.query('select spend_wallet_support($1,1,1000,gen_random_uuid())',[owner]);
    await db.query('select * from claim_due_wallet_settlements(1)');
    const snapshot = async () => ({
      data: await Promise.all([...walletTables,'supports','wallet_transfer_guards','wallet_payment_risks',
        'wallet_payment_risk_events'].map(async t=>(await db.query(`select to_jsonb(t) as row from public.${t} t order by to_jsonb(t)::text`)).rows)),
      policies: (await db.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows,
      functions: (await db.query(`select p.oid, p.proacl, pg_get_functiondef(p.oid) as definition from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.oid`)).rows,
      otherGrants: (await db.query(`select c.oid,r.name,p.privilege,
        has_table_privilege(r.name,c.oid,p.privilege) as allowed
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        cross join (values ('anon'),('authenticated'),('service_role')) r(name)
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
        where n.nspname='public' and c.relkind='r'
          and not (r.name='authenticated' and c.relname=any($1::text[]) and p.privilege in ('TRUNCATE','REFERENCES','TRIGGER'))
        order by c.oid,r.name,p.privilege`,[walletTables])).rows,
      defaults: (await db.query('select * from pg_default_acl order by oid')).rows,
    });
    const before = await snapshot();
    for (let attempt=0; attempt<2; attempt++) {
      await db.exec(repair);
      const good = await check();
      assert.equal(good.audit_status,'PASS');
      assert.equal(Number(good.checks_total),178);
      assert.equal(Number(good.nonpassing_checks),0);
      assert.deepEqual(good.findings,[]);
      assert.deepEqual(await snapshot(),before);
    }
    // Normal browser reads and service RPCs still execute after the repair.
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*)::int as n from wallets')).rows[0].n,1);
    await db.exec('reset role; set role service_role');
    await db.query('select record_wallet_topup($1,$2,$3,1000)',['cs_access','pi_access',owner]);
    await db.exec('reset role');
    assert.deepEqual(await snapshot(),before);
  } finally { await db.close(); }
});

test('repair rolls back if an inherited grant remains or required reads are missing', async () => {
  const db = new PGlite();
  try {
    await fixture(db, true);
    await db.exec('create role wallet_grant_source; grant wallet_grant_source to authenticated');
    const cases = [
      ['grant truncate on wallets to wallet_grant_source','revoke truncate on wallets from wallet_grant_source','WALLET_EXTRA_PRIVILEGE_REMAINS'],
      ['grant references(user_id) on wallets to wallet_grant_source','revoke references(user_id) on wallets from wallet_grant_source','WALLET_EXTRA_PRIVILEGE_REMAINS'],
      ['grant trigger on wallets to public','revoke trigger on wallets from public','WALLET_EXTRA_PRIVILEGE_REMAINS'],
      ['revoke select on wallets from authenticated','grant select on wallets to authenticated','WALLET_READ_PRIVILEGE_MISSING'],
    ];
    for (const [setup,cleanup,error] of cases) {
      await db.exec(setup);
      const before = (await db.query(audit)).rows[0];
      await assert.rejects(db.exec(repair),new RegExp(error));
      await db.exec('rollback');
      assert.deepEqual((await db.query(audit)).rows[0],before);
      await db.exec(cleanup);
    }
    await db.exec(repair);
    assert.equal((await db.query(audit)).rows[0].audit_status,'PASS');
  } finally { await db.close(); }
});

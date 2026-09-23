import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const audit = readFileSync(new URL('../supabase/staging/check_wallet_access.sql', import.meta.url), 'utf8');

test('hosted access runner offline tests', () => {
  execFileSync('python3', [new URL('wallet_access_runner_test.py', import.meta.url).pathname],
    { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
});

test('read-only access audit detects grants, columns, RLS, roles, RPCs and views', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public,auth to anon,authenticated,service_role;`);
    await db.exec(readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url),'utf8'));
    for (const file of ['20260920_wallet_ledger.sql','20260921_wallet_safety.sql',
      '20260922_wallet_capability_recovery.sql','20260923_wallet_balance_recovery.sql']) {
      await db.exec(readFileSync(new URL('../supabase/migrations/'+file, import.meta.url),'utf8')
        .replace('create extension if not exists pgcrypto;',''));
    }
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

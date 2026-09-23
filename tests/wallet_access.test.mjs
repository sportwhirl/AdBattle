import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const audit = readFileSync(new URL('../supabase/staging/check_wallet_access.sql', import.meta.url), 'utf8');
const repair = readFileSync(new URL('../supabase/migrations/20260923_wallet_table_privileges.sql', import.meta.url), 'utf8');
const seedPrivilegeRepair = readFileSync(
  new URL('../supabase/migrations/20260923164351_paid_seed_read_rpc_privileges.sql', import.meta.url),
  'utf8',
);
const clientPrivilegeHardening = readFileSync(
  new URL('../supabase/migrations/20260923183000_client_privilege_hardening.sql', import.meta.url),
  'utf8',
);
const walletTables = ['wallets','wallet_topups','wallet_transactions','ad_settlement_state','support_settlements'];
const protectedSequences = [
  'ads_id_seq','supports_id_seq','wallet_topups_id_seq','wallet_transactions_id_seq',
];

async function fixture(db, broadDefaults = false, includeSeedPrivilegeRepair = true) {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.exec(readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url),'utf8'));
  // Model broad hosted defaults for newly created wallet tables and functions.
  // The existing legacy supports table already has its intended base grants.
  if (broadDefaults) await db.exec(`
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to service_role;
  `);
  for (const file of ['20260920_wallet_ledger.sql','20260921_wallet_safety.sql',
    '20260922_wallet_capability_recovery.sql','20260923_wallet_balance_recovery.sql',
    '20260923093000_paid_seeds.sql']) {
    await db.exec(readFileSync(new URL('../supabase/migrations/'+file, import.meta.url),'utf8')
      .replace('create extension if not exists pgcrypto;',''));
  }
  if (includeSeedPrivilegeRepair) await db.exec(seedPrivilegeRepair);
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
    await db.exec(clientPrivilegeHardening);
    const check = async () => (await db.query(audit)).rows[0];
    // The audit itself must execute successfully in a READ ONLY transaction.
    await db.exec('begin read only');
    const good = await check();
    await db.exec('rollback');
    assert.equal(good.audit_status,'PASS');
    assert.equal(Number(good.checks_total),257);
    assert.equal(Number(good.nonpassing_checks),0);
    assert.deepEqual(good.findings,[]);
    const cases = [
      ['insert grant','grant insert on wallets to authenticated','table_privilege','authenticated:public.wallets:INSERT'],
      ['column update','grant update(available_cents) on wallets to authenticated','table_privilege','authenticated:public.wallets:UPDATE'],
      ['PUBLIC read','grant select on wallet_payment_risks to public','table_privilege','anon:public.wallet_payment_risks:SELECT'],
      ['truncate grant','grant truncate on wallets to authenticated','table_privilege','authenticated:public.wallets:TRUNCATE'],
      ['maintain grant','grant maintain on wallets to authenticated','table_privilege','authenticated:public.wallets:MAINTAIN'],
      ['ad maintain grant','grant maintain on ads to authenticated',
        'ads_privilege_boundary','authenticated:public.ads:unsafe_table_or_column_privileges'],
      ['sequence usage','grant usage on sequence wallet_topups_id_seq to authenticated',
        'sequence_privilege','authenticated:public.wallet_topups_id_seq:USAGE'],
      ['disabled RLS','alter table wallets disable row level security','row_security','public.wallets'],
      ['bypass role','alter role authenticated bypassrls','role_bypass','authenticated'],
      ['role inheritance','grant service_role to authenticated','service_role_membership','authenticated'],
      ['client RPC','grant execute on function spend_wallet_support(uuid,bigint,bigint,uuid) to authenticated',
        'function_privilege','authenticated:public.spend_wallet_support(uuid,bigint,bigint,uuid)'],
      ['Seed table read','grant select on ad_seeds to authenticated',
        'table_privilege','authenticated:public.ad_seeds:SELECT'],
      ['Seed RPC','grant execute on function seed_ad_from_wallet(uuid,bigint,uuid) to authenticated',
        'function_privilege','authenticated:public.seed_ad_from_wallet(uuid,bigint,uuid)'],
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

test('forward repairs remove hosted wallet table grants without changing data or server access', async () => {
  const db = new PGlite();
  try {
    await fixture(db, true);
    const check = async () => (await db.query(audit)).rows[0];
    const bad = await check();
    assert.equal(bad.audit_status,'REVIEW_REQUIRED');
    assert.equal(Number(bad.nonpassing_checks),22);
    assert.deepEqual(bad.findings.map(f=>f.object_name).sort(),[
      ...walletTables.flatMap(t=>['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'].map(
        p=>`authenticated:public.${t}:${p}`,
      )),
      'authenticated:public.ads_id_seq:USAGE',
      'authenticated:public.ads:exact_insert_columns',
    ].sort());
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
      data: await Promise.all([...walletTables,'ad_seeds','supports','wallet_transfer_guards','wallet_payment_risks',
        'wallet_payment_risk_events'].map(async t=>(await db.query(`select to_jsonb(t) as row from public.${t} t order by to_jsonb(t)::text`)).rows)),
      policies: (await db.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows,
      functions: (await db.query(`select p.oid, p.proacl, pg_get_functiondef(p.oid) as definition from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.oid`)).rows,
      otherGrants: (await db.query(`select c.oid,r.name,p.privilege,
        has_table_privilege(r.name,c.oid,p.privilege) as allowed
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        cross join (values ('anon'),('authenticated'),('service_role')) r(name)
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(privilege)
        where n.nspname='public' and c.relkind='r'
          and not (r.name='authenticated' and c.relname=any($1::text[])
            and p.privilege in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'))
          and not (r.name='authenticated' and c.relname='ads' and p.privilege='INSERT')
        order by c.oid,r.name,p.privilege`,[walletTables])).rows,
      defaults: (await db.query('select * from pg_default_acl order by oid')).rows,
    });
    const before = await snapshot();
    for (let attempt=0; attempt<2; attempt++) {
      await db.exec(repair);
      const partial = await check();
      assert.equal(Number(partial.nonpassing_checks),attempt === 0 ? 7 : 0);
      assert.deepEqual(partial.findings.map(f=>f.object_name).sort(),attempt === 0
        ? [
            ...walletTables.map(t=>`authenticated:public.${t}:MAINTAIN`),
            'authenticated:public.ads_id_seq:USAGE',
            'authenticated:public.ads:exact_insert_columns',
          ].sort()
        : []);
      await db.exec(clientPrivilegeHardening);
      const good = await check();
      assert.equal(good.audit_status,'PASS');
      assert.equal(Number(good.checks_total),257);
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

test('paid Seed forward repair removes hosted read-RPC grants only', async () => {
  const db = new PGlite();
  try {
    await fixture(db, true, false);
    await db.exec(repair);
    await db.exec(clientPrivilegeHardening);
    const check = async () => (await db.query(audit)).rows[0];
    const bad = await check();
    assert.equal(bad.audit_status,'REVIEW_REQUIRED');
    assert.equal(Number(bad.nonpassing_checks),2);
    assert.deepEqual(bad.findings.map(f=>f.object_name).sort(),[
      'service_role:public.get_my_seeded_ad_ids()',
      'service_role:public.get_seed_counts()',
    ]);
    const before = await Promise.all([
      db.query('select to_jsonb(t) as row from wallets t order by user_id'),
      db.query('select to_jsonb(t) as row from wallet_transactions t order by id'),
      db.query('select to_jsonb(t) as row from supports t order by id'),
      db.query('select to_jsonb(t) as row from ad_seeds t order by user_id,ad_id'),
    ]);
    for (let attempt=0; attempt<2; attempt++) {
      await db.exec(seedPrivilegeRepair);
      const good = await check();
      assert.equal(good.audit_status,'PASS');
      assert.equal(Number(good.checks_total),257);
      assert.equal(Number(good.nonpassing_checks),0);
      assert.deepEqual(good.findings,[]);
    }
    assert.deepEqual(await Promise.all([
      db.query('select to_jsonb(t) as row from wallets t order by user_id'),
      db.query('select to_jsonb(t) as row from wallet_transactions t order by id'),
      db.query('select to_jsonb(t) as row from supports t order by id'),
      db.query('select to_jsonb(t) as row from ad_seeds t order by user_id,ad_id'),
    ]),before);
    await db.exec('set role service_role');
    assert.equal((await db.query(`select has_function_privilege(
      'service_role','public.seed_ad_from_wallet(uuid,bigint,uuid)','execute') as allowed`)).rows[0].allowed,true);
    await assert.rejects(db.query('select * from get_seed_counts()'),/permission denied/);
    await assert.rejects(db.query('select * from get_my_seeded_ad_ids()'),/permission denied/);
    await db.exec('reset role');
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
    await db.exec(clientPrivilegeHardening);
    assert.equal((await db.query(audit)).rows[0].audit_status,'PASS');
  } finally { await db.close(); }
});

test('client privilege hardening removes PG17 maintenance and sequence access only', async () => {
  const db = new PGlite();
  try {
    await fixture(db, true);
    await db.exec(repair);
    await db.exec(`
      grant truncate, references, trigger, maintain on supports to anon, authenticated;
      grant all privileges on sequence ads_id_seq, supports_id_seq,
        wallet_topups_id_seq, wallet_transactions_id_seq to anon, authenticated;
    `);
    const check = async () => (await db.query(audit)).rows[0];
    const bad = await check();
    assert.equal(bad.audit_status,'REVIEW_REQUIRED');
    assert.equal(Number(bad.nonpassing_checks),38);
    const expected = [
      ...walletTables.map(t=>`authenticated:public.${t}:MAINTAIN`),
      ...['anon','authenticated'].flatMap(role=>
        ['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'].map(p=>`${role}:public.supports:${p}`)),
      ...['anon','authenticated'].flatMap(role=>protectedSequences.flatMap(sequence=>
        ['SELECT','UPDATE','USAGE'].map(p=>`${role}:public.${sequence}:${p}`))),
      'authenticated:public.ads:exact_insert_columns',
    ].sort();
    assert.deepEqual(bad.findings.map(f=>f.object_name).sort(),expected);

    const snapshot = async () => ({
      data: await Promise.all([...walletTables,'ad_seeds','supports','wallet_transfer_guards',
        'wallet_payment_risks','wallet_payment_risk_events'].map(async t=>(await db.query(
          `select to_jsonb(row_data) as row from public.${t} row_data order by to_jsonb(row_data)::text`,
        )).rows)),
      policies: (await db.query(
        "select * from pg_policies where schemaname='public' order by tablename,policyname",
      )).rows,
      functions: (await db.query(`select p.oid,p.proacl,pg_get_functiondef(p.oid) as definition
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' order by p.oid`)).rows,
      serviceTables: (await db.query(`select c.relname,p.privilege,
        has_table_privilege('service_role',c.oid,p.privilege) as allowed
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
          ('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(privilege)
        where n.nspname='public' and c.relname=any($1::text[])
        order by c.relname,p.privilege`,[[...walletTables,'supports']])).rows,
      serviceSequences: (await db.query(`select c.relname,p.privilege,
        has_sequence_privilege('service_role',c.oid,p.privilege) as allowed
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        cross join (values ('USAGE'),('SELECT'),('UPDATE')) p(privilege)
        where n.nspname='public' and c.relname=any($1::text[])
        order by c.relname,p.privilege`,[protectedSequences])).rows,
      defaults: (await db.query('select * from pg_default_acl order by oid')).rows,
    });
    const before = await snapshot();
    for (let attempt=0; attempt<2; attempt++) {
      await db.exec(clientPrivilegeHardening);
      const good = await check();
      assert.equal(good.audit_status,'PASS');
      assert.equal(Number(good.checks_total),257);
      assert.equal(Number(good.nonpassing_checks),0);
      assert.deepEqual(good.findings,[]);
      assert.deepEqual(await snapshot(),before);
    }

    const poster = '00000000-0000-4000-8000-000000000099';
    await db.query('insert into auth.users values ($1)',[poster]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[poster]);
    await db.exec('set role authenticated');
    const posted = (await db.query(`insert into ads(
      user_id,title,caption,image_url,promotion_allocation
    ) values ($1,'Identity post','Allowed columns','https://example.invalid/post.png',
      '{"youtube":20,"instagram":20,"tiktok":20,"snapchat":20,"facebook":20}'::jsonb)
      returning id`,[poster])).rows[0];
    assert.ok(Number(posted.id) > 0);
    await assert.rejects(db.query("select nextval('public.ads_id_seq')"),/permission denied/);
    await assert.rejects(db.query(`insert into ads(
      user_id,title,image_url,moderation_status
    ) values ($1,'Forbidden column','https://example.invalid/post.png','approved')`,[poster]),
    /permission denied/);
    await db.exec('reset role');

    for (const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      assert.equal((await db.query('select count(*)::int as n from supports')).rows[0].n,0);
      for (const sequence of protectedSequences) {
        await assert.rejects(db.query(`select nextval('public.${sequence}')`),/permission denied/);
      }
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});

test('client privilege hardening rolls back on inherited grants or missing reads', async () => {
  const db = new PGlite();
  try {
    await fixture(db, true);
    await db.exec(repair);
    await db.exec(`
      create role client_grant_source;
      grant client_grant_source to authenticated;
      grant truncate, references, trigger, maintain on supports to anon, authenticated;
      grant all privileges on sequence ads_id_seq, supports_id_seq,
        wallet_topups_id_seq, wallet_transactions_id_seq to anon, authenticated;
    `);
    const cases = [
      [
        'grant maintain on wallets to client_grant_source',
        'revoke maintain on wallets from client_grant_source',
        'WALLET_MAINTAIN_PRIVILEGE_REMAINS',
      ],
      [
        'grant maintain on wallets to public',
        'revoke maintain on wallets from public',
        'WALLET_MAINTAIN_PRIVILEGE_REMAINS',
      ],
      [
        'grant maintain on ads to public',
        'revoke maintain on ads from public',
        'ADS_CLIENT_PRIVILEGE_REMAINS',
      ],
      [
        'grant references(user_id) on supports to client_grant_source',
        'revoke references(user_id) on supports from client_grant_source',
        'SUPPORTS_CLIENT_PRIVILEGE_REMAINS',
      ],
      [
        'grant usage on sequence wallet_topups_id_seq to public',
        'revoke usage on sequence wallet_topups_id_seq from public',
        'CLIENT_SEQUENCE_PRIVILEGE_REMAINS',
      ],
      [
        'revoke select on supports from anon',
        'grant select on supports to anon',
        'SUPPORTS_READ_PRIVILEGE_MISSING',
      ],
    ];
    for (const [setup,cleanup,error] of cases) {
      await db.exec(setup);
      const before = (await db.query(audit)).rows[0];
      await assert.rejects(db.exec(clientPrivilegeHardening),new RegExp(error));
      await db.exec('rollback');
      assert.deepEqual((await db.query(audit)).rows[0],before);
      await db.exec(cleanup);
    }
    await db.exec(clientPrivilegeHardening);
    const good = (await db.query(audit)).rows[0];
    assert.equal(good.audit_status,'PASS');
    assert.equal(Number(good.checks_total),257);
  } finally { await db.close(); }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('supplied staging schema supports all wallet migrations and real wallet RPCs', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
    `);
    const base = readFileSync(new URL('../supabase/staging/00_test_base.sql', import.meta.url), 'utf8');
    assert.ok(!base.includes('bmsrdzqprxvldltaislp'));
    await db.exec(base);
    for (const name of ['20260920_wallet_ledger.sql', '20260921_wallet_safety.sql', '20260922_wallet_capability_recovery.sql', '20260922_duplicate_screening.sql']) {
      const sql = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
      await db.exec(sql.replace('create extension if not exists pgcrypto;', ''));
    }
    const supporter = '00000000-0000-4000-8000-000000000001';
    const creator = '00000000-0000-4000-8000-000000000002';
    await db.query('insert into auth.users values ($1), ($2)', [supporter, creator]);
    const ad = (await db.query(`insert into ads(user_id,title,image_url)
      values ($1,'Synthetic test ad','https://example.invalid/test.png') returning id,moderation_status`, [creator])).rows[0];
    assert.equal(ad.moderation_status, 'pending_scan');
    const triggers = await db.query("select tgname from pg_trigger where tgrelid='public.ads'::regclass and not tgisinternal");
    assert.deepEqual(triggers.rows.map(row => row.tgname), ['enforce_ad_screening_gate']);
    await db.query('select record_wallet_topup($1,$2,$3,1000)', ['cs_test','pi_test',supporter]);
    await db.query("select record_ad_duplicate_scan($1,$2,$3,$4)", [ad.id,'11'.repeat(32),'0123456789abcdef','dhash-9x8-luma-v1']);
    await db.query("select record_ad_safety_scan($1,'passed',null)", [ad.id]);
    await db.query('select spend_wallet_support($1,$2,1,gen_random_uuid())', [supporter,ad.id]);
    const split = (await db.query('select creator_amount_micros,platform_amount_micros from supports')).rows[0];
    assert.equal(split.creator_amount_micros,9000);
    assert.equal(split.platform_amount_micros,1000);
    assert.equal((await db.query('select available_cents from wallets')).rows[0].available_cents,999);
    await assert.rejects(db.exec(base), /Expected an empty test project/);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int as n from supports')).rows[0].n,1);
  } finally {
    await db.close();
  }
});

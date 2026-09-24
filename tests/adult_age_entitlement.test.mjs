import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260924013505_adult_age_entitlement_foundation.sql',
  import.meta.url,
), 'utf8');
const adult = '00000000-0000-4000-8000-000000000001';
const child = '00000000-0000-4000-8000-000000000002';
const unknown = '00000000-0000-4000-8000-000000000003';
const underLocalAge = '00000000-0000-4000-8000-000000000004';

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(
      id uuid primary key, is_anonymous boolean default false,
      deleted_at timestamptz, banned_until timestamptz
    );
    insert into auth.users(id) values
      ('${adult}'), ('${child}'), ('${unknown}'), ('${underLocalAge}');
  `);
  await db.exec(migration);
  return db;
}

async function decide(db, userId, scope = 'ai_image_generate',
  route = 'openai_images') {
  await db.exec('reset role; set role service_role');
  const result = await db.query(
    'select public.has_adult_entitlement($1, $2, $3) as allowed',
    [userId, scope, route],
  );
  return result.rows[0].allowed;
}

async function assess(db, userId, band = 'adult', status = 'active') {
  await db.exec('reset role');
  await db.query(`insert into age_private.age_entitlements
    (user_id, age_band, state, assessment_method, jurisdiction, policy_version,
      assessed_at, expires_at)
    values ($1, $2, $3, 'verified_provider', 'US-CA', 'adult-v1',
      now() - interval '1 day', now() + interval '7 days')`,
  [userId, band, status]);
}

async function grant(db, userId, scope = 'ai_image_generate',
  route = 'openai_images', version = 1, expiry = '7 days') {
  await db.exec('reset role');
  const { rows } = await db.query(`insert into age_private.capability_grants
    (id, user_id, scope, provider_route, entitlement_version, expires_at, grant_reason)
    values ($1, $2, $3, $4, $5, now() + $6::interval,
      'adult_staging_tester')
    returning id`, [randomUUID(), userId, scope, route, version, expiry]);
  return rows[0].id;
}

test('private tables, service-only RPC and RLS reject direct and metadata-forged clients', async () => {
  const db = await setup();
  try {
    await assess(db, adult);
    await grant(db, adult);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`);
      await db.query('select set_config($1, $2, false)', [
        'request.jwt.claims',
        JSON.stringify({ sub: adult, user_metadata: { age: 30, adult: true },
          app_metadata: { adult: true, ai_image: true } }),
      ]);
      await assert.rejects(
        db.query('select public.has_adult_entitlement($1,$2,$3)',
          [adult, 'ai_image_generate', 'openai_images']),
        /permission denied/,
      );
      await assert.rejects(
        db.query('select * from age_private.age_entitlements'),
        /permission denied/,
      );
      await assert.rejects(
        db.query('select * from age_private.capability_grants'),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`insert into age_private.age_entitlements
          (user_id, age_band, state) values ($1, 'adult', 'active')`, [unknown]),
        /permission denied/,
      );
    }
    await db.exec('reset role');
    // Defense in depth: even if someone later adds a schema/table read grant,
    // an ordinary authenticated role still sees zero rows under RLS.
    await db.exec(`grant usage on schema age_private to authenticated;
      grant select on age_private.age_entitlements,
        age_private.capability_grants to authenticated;
      set role authenticated;`);
    assert.deepEqual((await db.query('select * from age_private.age_entitlements')).rows, []);
    assert.deepEqual((await db.query('select * from age_private.capability_grants')).rows, []);
  } finally { await db.close(); }
});

test('missing, unknown, minor, wrong scope and expired records fail closed', async () => {
  const db = await setup();
  try {
    assert.equal(await decide(db, unknown), false);
    await assess(db, adult);
    await assess(db, child, 'minor_eligible');
    await assess(db, underLocalAge, 'below_local_consent');
    await assess(db, unknown, 'unknown', 'pending');
    await assert.rejects(
      db.query(`update age_private.age_entitlements
        set assessment_method='DOB 2000-01-01' where user_id=$1`, [adult]),
      /check constraint/,
    );
    assert.equal(await decide(db, adult), false); // Assessment alone is not a grant.
    await grant(db, adult);
    await grant(db, child);
    await grant(db, underLocalAge);
    await grant(db, unknown);
    assert.equal(await decide(db, adult), true);
    for (const scope of ['ai_image_submit', 'ai_video_create',
      'ordinary_post', 'payout', 'all', '', null])
      assert.equal(await decide(db, adult, scope), false, String(scope));
    for (const route of ['luma_video', 'still_animation', 'none', '', null])
      assert.equal(await decide(db, adult, 'ai_image_generate', route),
        false, String(route));
    assert.equal(await decide(db, child), false);
    assert.equal(await decide(db, underLocalAge), false);
    assert.equal(await decide(db, unknown), false);
    assert.equal(await decide(db, null), false);
    await db.exec('reset role');
    await db.query(`update age_private.age_entitlements
      set expires_at = now() - interval '1 minute' where user_id = $1`, [adult]);
    assert.equal(await decide(db, adult), false);
  } finally { await db.close(); }
});

test('provider route and action grants are separate; invalid pairs cannot be issued', async () => {
  const db = await setup();
  try {
    await assess(db, adult);
    const luma = await grant(db, adult, 'ai_video_create', 'luma_video');
    assert.equal(await decide(db, adult, 'ai_video_create', 'luma_video'), true);
    assert.equal(await decide(db, adult, 'ai_video_create', 'still_animation'), false);
    assert.equal(await decide(db, adult, 'ai_video_dispatch', 'luma_video'), false);
    assert.equal(await decide(db, adult, 'ai_image_generate', 'openai_images'), false);
    await assert.rejects(
      grant(db, adult, 'ai_video_create', 'openai_images'),
      /age_scope_provider_route/,
    );
    await assert.rejects(
      grant(db, adult, 'ordinary_post', 'luma_video'),
      /age_scope_provider_route/,
    );
    await grant(db, adult, 'ordinary_upload', 'none');
    assert.equal(await decide(db, adult, 'ordinary_upload', 'none'), true);
    assert.equal(await decide(db, adult, 'ordinary_post', 'none'), false);
    assert.equal(await decide(db, adult, 'financial_support', 'none'), false);
    // The trusted service role can immediately revoke a route under RLS.
    await db.exec('reset role; set role service_role');
    await db.query('update age_private.capability_grants set revoked_at=now() where id=$1',
      [luma]);
    assert.equal(await decide(db, adult, 'ai_video_create', 'luma_video'), false);
  } finally { await db.close(); }
});

test('grant expiry, revocation and reissuance are live and cannot un-revoke a grant', async () => {
  const db = await setup();
  try {
    await assess(db, adult);
    const old = await grant(db, adult);
    assert.equal(await decide(db, adult), true);
    await db.exec('reset role');
    await db.query(`update age_private.capability_grants
      set revoked_at=now() where id=$1`, [old]);
    assert.equal(await decide(db, adult), false);
    await assert.rejects(
      db.query('update age_private.capability_grants set revoked_at=null where id=$1', [old]),
      /AGE_GRANT_IMMUTABLE/,
    );
    const renewed = await grant(db, adult);
    assert.equal(await decide(db, adult), true);
    await db.exec('reset role');
    await db.query(`update age_private.capability_grants
      set revoked_at=now() where id=$1`, [renewed]);
    await grant(db, adult, 'ai_image_generate', 'openai_images', 1, '-1 minute').then(
      () => assert.fail('invalid expiry should reject'),
      (error) => assert.match(error.message, /grant_expiry_after_issuance/),
    );
    await db.query(`insert into age_private.capability_grants
      (user_id, scope, provider_route, entitlement_version, granted_at, expires_at, grant_reason)
      values ($1, 'ai_image_generate', 'openai_images', 1,
        now()-interval '2 days', now()-interval '1 day',
        'manual_renewal')`, [adult]);
    assert.equal(await decide(db, adult), false);
  } finally { await db.close(); }
});

test('status changes invalidate stale grants; disabled Auth accounts cannot use a grant', async () => {
  const db = await setup();
  try {
    await assess(db, adult);
    await grant(db, adult);
    assert.equal(await decide(db, adult), true);
    await db.exec('reset role');
    await db.query(`update age_private.age_entitlements
      set state='revoked', revoked_at=now() where user_id=$1`, [adult]);
    assert.equal(await decide(db, adult), false);
    await db.exec('reset role');
    await db.query(`update age_private.age_entitlements
      set state='active', revoked_at=null where user_id=$1`, [adult]);
    assert.equal(await decide(db, adult), false); // Old version stays invalid.
    const version = (await db.query(
      'select version from age_private.age_entitlements where user_id=$1',
      [adult],
    )).rows[0].version;
    assert.equal(Number(version), 3);
    await grant(db, adult, 'ai_image_generate', 'openai_images', Number(version));
    assert.equal(await decide(db, adult), true);
    for (const change of [
      'is_anonymous=true', 'deleted_at=now()',
      `banned_until=now()+interval '1 day'`,
    ]) {
      await db.exec('reset role');
      await db.query(`update auth.users set ${change} where id=$1`, [adult]);
      assert.equal(await decide(db, adult), false, change);
      await db.exec('reset role');
      await db.query(`update auth.users set is_anonymous=false,
        deleted_at=null, banned_until=null where id=$1`, [adult]);
      assert.equal(await decide(db, adult), true);
    }
  } finally { await db.close(); }
});

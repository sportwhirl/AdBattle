import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { adultTestApproved, adultVideoEntitled, assertStaging, draftHash, MODEL,
  normalizeDraft, STAGING_URL } from '../supabase/functions/_shared/ai-video-draft.mjs';

const prompt = 'A playful pencil dances around a bright notebook';
const user = '00000000-0000-4000-8000-000000000001';
const draft = { action: 'create', request_id: '20000000-0000-4000-8000-000000000001',
  prompt, aspect_ratio: '16:9' };

test('Wan2.1 staging input accepts text only and disallows expensive client knobs', async () => {
  assert.equal(MODEL, 'Wan-AI/Wan2.1-T2V-1.3B');
  assert.throws(() => assertStaging({ SUPABASE_URL: 'https://adbattle.io' }), /STAGING_GUARD/);
  assertStaging({ SUPABASE_URL: STAGING_URL, ADBATTLE_AI_STAGING_ENABLED: 'video-drafts-v1' });
  assert.equal(adultTestApproved({ app_metadata: { ai_video_adult_test_approved: true } }), true);
  assert.equal(adultTestApproved({ user_metadata: { ai_video_adult_test_approved: true } }), false);
  assert.equal(normalizeDraft(draft).style, 'freeform_simple');
  for (const change of [
    { model: 'hosted-wan' }, { duration: '10s' }, { resolution: '1080p' },
    { source_image_request_id: '10000000-0000-4000-8000-000000000001' },
    { aspect_ratio: '4:3' },
    { prompt: 'bad\0prompt' }, { style: 'not-listed' },
  ]) assert.throws(() => normalizeDraft({ ...draft, ...change }));
  const hash = await draftHash(normalizeDraft(draft));
  assert.equal(hash, await draftHash(normalizeDraft({ ...draft, prompt: `  ${prompt}  ` })));
  assert.notEqual(hash, await draftHash(normalizeDraft({ ...draft, prompt: `${prompt} now` })));
  assert.notEqual(hash, await draftHash(normalizeDraft({ ...draft, aspect_ratio: '9:16' })));
});

test('server-owned grants bind Wan2.1 create and GPU dispatch independently', async () => {
  const calls = [];
  const db = { async rpc(name, args) { calls.push([name, args]); return { data: true, error: null }; } };
  assert.equal(await adultVideoEntitled(db, user, 'ai_video_create'), true);
  assert.equal(await adultVideoEntitled(db, user, 'ai_video_dispatch'), true);
  assert.deepEqual(calls.map(([, args]) => args.p_provider_route), ['wan21_t2v', 'wan21_t2v']);
  assert.equal(await adultVideoEntitled(db, user, 'ai_video_publish'), false);
  assert.equal(await adultVideoEntitled({ rpc: async () => ({ data: false }) }, user, 'ai_video_dispatch'), false);
  assert.equal(await adultVideoEntitled({ rpc: async () => { throw Error('offline'); } }, user, 'ai_video_dispatch'), false);
});

test('unapplied text-to-video schema enforces quotas, claim and private output', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create table storage.buckets(id text primary key, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to authenticated, anon, service_role;`);
    const users = Array.from({ length: 6 }, (_, n) =>
      `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`);
    for (const id of users) await db.query('insert into auth.users values($1)', [id]);
    await db.exec(readFileSync(new URL('../supabase/migrations/20260923163511_ai_video_draft_jobs.sql', import.meta.url), 'utf8'));
    assert.equal((await db.query("select public from storage.buckets where id='ai-video-drafts'"))
      .rows[0].public, false);
    const insert = (owner, suffix) => db.query(`insert into ai_video_draft_jobs
      (user_id,request_id,request_hash,prompt,aspect_ratio)
      values ($1,$2,$3,$4,'16:9') returning id`,
      [owner, `20000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
        'b'.repeat(64), prompt]);
    const first = (await insert(users[0], 1)).rows[0].id;
    await assert.rejects(insert(users[0], 3), /AI_VIDEO_USER_DAILY_LIMIT/);
    await assert.rejects(db.query('update ai_video_draft_jobs set prompt=$1 where id=$2',
      ['modified prompt beyond twelve characters', first]), /AI_VIDEO_REQUEST_IMMUTABLE/);
    for (let n = 1; n < 5; n++) {
      await insert(users[n], n + 1);
    }
    await assert.rejects(insert(users[5], 6), /AI_VIDEO_GLOBAL_DAILY_LIMIT/);
    await db.query("update ai_video_draft_jobs set status='queued', reviewed_at=now(), reviewed_by='operator', reviewed_request_hash=request_hash where id=$1", [first]);
    await db.exec('set role service_role');
    const claimed = await db.query('select id,status,model,duration,resolution from claim_wan21_video_job()');
    assert.equal(claimed.rows.length, 1);
    assert.deepEqual(claimed.rows[0], { id: first, status: 'dispatching', model: MODEL,
      duration: '5s', resolution: '480p' });
    assert.equal((await db.query('select id from claim_wan21_video_job()')).rows.length, 0);
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [users[0]]);
    await db.exec('set role authenticated');
    assert.deepEqual((await db.query('select id from ai_video_draft_jobs')).rows.map(row => row.id), [first]);
    await assert.rejects(db.query('select prompt from ai_video_draft_jobs'), /permission denied/);
    await assert.rejects(db.query('select original_private_path from ai_video_draft_jobs'), /permission denied/);
    await assert.rejects(db.query('select * from claim_wan21_video_job()'), /permission denied/);
  } finally { await db.close(); }
});

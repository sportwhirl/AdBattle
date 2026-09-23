import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { assertStaging, boundedJson, draftHash, fileNameFromUri, interactionResult,
  normalizeDraft, paidDispatchOnce, providerCall, providerRequest } from '../supabase/functions/_shared/ai-video-draft.mjs';

const prompt = 'A playful pencil dances around a bright notebook';
const valid = { action: 'create', request_id: '00000000-0000-4000-8000-000000000001',
  prompt, aspect_ratio: '16:9' };

test('staging guard and fixed generation parameters refuse arbitrary client knobs', async () => {
  assert.throws(() => assertStaging({ SUPABASE_URL: 'https://adbattle.io',
    ADBATTLE_AI_STAGING_ENABLED: 'video-drafts-v1' }), /STAGING_GUARD/);
  assert.throws(() => assertStaging({ SUPABASE_URL: 'https://nccqnrcdygujulrnwair.supabase.co' }), /STAGING_GUARD/);
  assertStaging({ SUPABASE_URL: 'https://nccqnrcdygujulrnwair.supabase.co',
    ADBATTLE_AI_STAGING_ENABLED: 'video-drafts-v1' });
  const draft = normalizeDraft(valid);
  const request = providerRequest(draft);
  assert.deepEqual(request.response_format, { type: 'video', duration: '10s', resolution: '360p',
    aspect_ratio: '16:9', delivery: 'uri' });
  assert.equal(request.model, 'gemini-omni-1.1-flash');
  assert.equal(request.background, true);
  assert.equal(request.store, true);
  assert.match(request.input, /simple stylized visual treatment/);
  assert.throws(() => normalizeDraft({ ...valid, model: 'expensive' }), /UNSUPPORTED_PARAMETER/);
  assert.throws(() => normalizeDraft({ ...valid, aspect_ratio: '4:3' }), /INVALID_ASPECT_RATIO/);
  assert.throws(() => normalizeDraft({ ...valid, style: 'photorealistic' }), /INVALID_STYLE/);
  assert.throws(() => normalizeDraft({ ...valid, prompt: 'a\0bad prompt' }), /INVALID_PROMPT/);
  assert.equal(await draftHash(draft), await draftHash(normalizeDraft({ ...valid, prompt: `  ${prompt}  ` })));
  assert.notEqual(await draftHash(draft), await draftHash(normalizeDraft({ ...valid, aspect_ratio: '9:16' })));
  assert.notEqual(await draftHash(draft), await draftHash(normalizeDraft({ ...valid, style: 'pixel_art' })));
});

test('paid dispatch posts once after claim and preserves uncertain state or provider ID', async () => {
  const job = normalizeDraft(valid);
  let posts = 0;
  const patches = [];
  const uncertain = await paidDispatchOnce(job, async () => {
    posts++;
    throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }, async (patch) => patches.push(patch), () => 'later');
  assert.equal(posts, 1);
  assert.equal(uncertain.status, 'dispatch_unknown');
  assert.deepEqual(patches[0], { status: 'dispatch_unknown', error_code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  const accepted = await paidDispatchOnce(job, async () => {
    posts++;
    return { id: 'v1_accepted', status: 'in_progress' };
  }, async (patch) => patches.push(patch), () => 'later');
  assert.equal(posts, 2); // One POST per separate, explicitly claimed job.
  assert.equal(accepted.status, 'in_progress');
  assert.equal(patches[1].provider_interaction_id, 'v1_accepted');
  assert.equal(patches[1].next_poll_at, 'later');
});

test('provider REST statuses and steps accept one URI but hold inline, unknown and mismatched output', () => {
  const id = 'v1_abc123';
  const video = (uri) => ({ id, model: 'gemini-omni-1.1-flash', status: 'completed',
    steps: [{ type: 'user_input', content: [{ type: 'video', uri: 'files/input' }] },
      { type: 'model_output', content: [{ type: 'video', uri, mime_type: 'video/mp4' }] }] });
  assert.deepEqual(interactionResult({ id, status: 'in_progress' }), { kind: 'in_progress', id });
  assert.deepEqual(interactionResult(video('files/abc-123')), { kind: 'file_pending', id,
    file_name: 'files/abc-123', file_uri: 'files/abc-123' });
  assert.equal(interactionResult(video('https://evil.test/files/abc')).kind, 'needs_review');
  assert.equal(interactionResult({ ...video('files/abc'), output_video: { data: 'abcd' } }).code,
    'UNEXPECTED_INLINE_VIDEO');
  assert.equal(interactionResult(video('files/abc'), 'v1_wrong').code, 'INVALID_INTERACTION');
  assert.equal(interactionResult({ id, status: 'completed', steps: [] }).kind, 'needs_review');
  assert.equal(interactionResult({ id, status: 'requires_action' }).kind, 'failed');
  assert.equal(fileNameFromUri('https://generativelanguage.googleapis.com/v1beta/files/abc-123'), 'files/abc-123');
  assert.equal(fileNameFromUri('https://generativelanguage.googleapis.com/v1beta/files/abc?key=secret'), null);
});

test('provider response is limited before parse even when content-length lies or inline data is huge', async () => {
  const huge = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(100)); controller.enqueue(new Uint8Array(100)); controller.close();
  } });
  await assert.rejects(boundedJson(new Response(huge, { headers: { 'content-length': '1' } }), 128),
    /PROVIDER_RESPONSE_TOO_LARGE/);
  await assert.rejects(boundedJson(new Response('{}', { headers: { 'content-length': '1000' } }), 128),
    /PROVIDER_RESPONSE_TOO_LARGE/);
  let calls = 0;
  const payload = { id: 'v1_test', status: 'in_progress' };
  const result = await providerCall(async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'private');
    return Response.json(payload);
  }, 'private', 'interactions', { method: 'POST', body: '{}' });
  assert.deepEqual(result, payload);
  assert.equal(calls, 1);
});

test('actual migration enforces day quotas, active slot, immutable request and owner-safe column grants', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to authenticated, anon, service_role;`);
    const users = Array.from({ length: 7 }, (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`);
    for (const user of users) await db.query('insert into auth.users values($1)', [user]);
    await db.exec(readFileSync(new URL('../supabase/migrations/20260923163511_ai_video_draft_jobs.sql', import.meta.url), 'utf8'));
    const insert = (index, suffix = 0) => db.query(`insert into public.ai_video_draft_jobs
      (user_id,request_id,request_hash,prompt,aspect_ratio) values ($1,$2,$3,$4,'16:9') returning id`,
      [users[index], `10000000-0000-4000-8000-${String(index * 10 + suffix + 1).padStart(12, '0')}`,
        'a'.repeat(64), prompt]);
    const first = (await insert(0)).rows[0].id;
    await assert.rejects(insert(0, 1), /AI_VIDEO_USER_DAILY_LIMIT/);
    await assert.rejects(db.query('update public.ai_video_draft_jobs set prompt=$1 where id=$2',
      ['changed text longer than twelve', first]), /AI_VIDEO_REQUEST_IMMUTABLE/);
    for (let n = 1; n < 5; n++) await insert(n);
    await assert.rejects(insert(5), /AI_VIDEO_GLOBAL_DAILY_LIMIT/);

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [users[0]]);
    await db.exec('set role authenticated');
    const visible = await db.query('select id,status from public.ai_video_draft_jobs');
    assert.deepEqual(visible.rows.map((r) => r.id), [first]);
    await assert.rejects(db.query('select provider_file_uri from public.ai_video_draft_jobs'), /permission denied/);
    await assert.rejects(db.query('select prompt from public.ai_video_draft_jobs'), /permission denied/);
    await assert.rejects(insert(6), /permission denied/);
  } finally { await db.close(); }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { adultTestApproved, assertStaging, boundedJson, draftHash, generationResult, normalizeDraft,
  paidDispatchOnce, providerCall, providerRequest, validatedDownloadUrl } from '../supabase/functions/_shared/ai-video-draft.mjs';

const prompt = 'A playful pencil dances around a bright notebook';
const valid = { action: 'create', request_id: '00000000-0000-4000-8000-000000000001',
  prompt, aspect_ratio: '16:9' };

test('staging guard and fixed generation parameters refuse arbitrary client knobs', async () => {
  assert.throws(() => assertStaging({ SUPABASE_URL: 'https://adbattle.io',
    ADBATTLE_AI_STAGING_ENABLED: 'video-audio-drafts-v2' }), /STAGING_GUARD/);
  assert.throws(() => assertStaging({ SUPABASE_URL: 'https://nccqnrcdygujulrnwair.supabase.co' }), /STAGING_GUARD/);
  assert.throws(() => assertStaging({ SUPABASE_URL: 'https://nccqnrcdygujulrnwair.supabase.co',
    ADBATTLE_AI_STAGING_ENABLED: 'video-drafts-v1' }), /STAGING_GUARD/);
  assertStaging({ SUPABASE_URL: 'https://nccqnrcdygujulrnwair.supabase.co',
    ADBATTLE_AI_STAGING_ENABLED: 'video-audio-drafts-v2' });
  assert.equal(adultTestApproved({ app_metadata: { ai_video_adult_test_approved: true } }), true);
  assert.equal(adultTestApproved({ user_metadata: { ai_video_adult_test_approved: true } }), false);
  assert.equal(adultTestApproved({ app_metadata: { ai_video_adult_test_approved: 'true' } }), false);
  const draft = normalizeDraft(valid);
  const request = providerRequest(draft);
  assert.deepEqual(request.video, { duration: '10s', resolution: '360p' });
  assert.equal(request.aspect_ratio, '16:9');
  assert.equal(request.model, 'ray-3.2');
  assert.equal(request.type, 'video');
  assert.equal(request.web_search, false);
  assert.match(request.prompt, /synchronized, original AI-generated soundtrack/);
  assert.match(request.prompt, /Do not imitate a named artist, celebrity/);
  assert.match(request.prompt, /Choose a visual style that fits the idea/);
  assert.match(providerRequest(normalizeDraft({ ...valid, style: 'pixel_art' })).prompt, /pixel art animation/);
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
    return { id: 'd290f1ee-6c54-4b01-90e6-d701748f0851', model: 'ray-3.2',
      type: 'video', state: 'queued', output: [] };
  }, async (patch) => patches.push(patch), () => 'later');
  assert.equal(posts, 2); // One POST per separate, explicitly claimed job.
  assert.equal(accepted.status, 'in_progress');
  assert.equal(patches[1].provider_generation_id, 'd290f1ee-6c54-4b01-90e6-d701748f0851');
  assert.equal(patches[1].next_poll_at, 'later');
  assert.equal(patches[1].provider_deadline_at, 'later');
  let successfulPost = 0;
  await assert.rejects(paidDispatchOnce(job, async () => {
    successfulPost++;
    return { id: 'd290f1ee-6c54-4b01-90e6-d701748f0851', model: 'ray-3.2',
      type: 'video', state: 'processing' };
  }, async () => { throw new Error('database write failed'); }, () => 'later'),
  /database write failed/);
  assert.equal(successfulPost, 1); // The caller may retry DB persistence, never generation.
});

test('Luma async states require one safe private video URL and preserve the generation ID', () => {
  const id = 'd290f1ee-6c54-4b01-90e6-d701748f0851';
  const url = 'https://media.lumalabs.ai/generations/abc/output.mp4?X-Amz-Expires=3600&signature=private';
  const base = { id, model: 'ray-3.2', type: 'video' };
  const video = (outputUrl) => ({ ...base, state: 'completed', output: [{ type: 'video', url: outputUrl }] });
  assert.deepEqual(generationResult({ ...base, state: 'queued', output: [] }), { kind: 'in_progress', id });
  assert.deepEqual(generationResult({ ...base, state: 'processing', output: [] }), { kind: 'in_progress', id });
  assert.deepEqual(generationResult(video(url)), { kind: 'ready', id, output_url: url });
  assert.equal(generationResult(video('http://media.lumalabs.ai/video.mp4')).kind, 'needs_review');
  assert.equal(generationResult(video('https://127.0.0.1/video.mp4')).kind, 'needs_review');
  assert.equal(generationResult(video('https://user:pass@media.lumalabs.ai/video.mp4')).kind, 'needs_review');
  assert.equal(generationResult({ ...video(url), output: [{ type: 'video', url }, { type: 'video', url }] }).kind, 'needs_review');
  assert.equal(generationResult(video(url), '00000000-0000-4000-8000-000000000001').code, 'INVALID_GENERATION');
  assert.equal(generationResult({ ...base, state: 'completed', output: [] }).kind, 'needs_review');
  assert.equal(generationResult({ ...base, state: 'failed', failure_code: 'content_moderated' }).code,
    'PROVIDER_CONTENT_MODERATED');
  assert.equal(generationResult({ ...base, state: 'other' }).kind, 'needs_review');
  assert.equal(validatedDownloadUrl(url), url);
  assert.equal(validatedDownloadUrl(`https://media.lumalabs.ai/${'a'.repeat(8192)}`), null);
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
  const payload = { id: 'd290f1ee-6c54-4b01-90e6-d701748f0851', model: 'ray-3.2',
    type: 'video', state: 'queued' };
  const result = await providerCall(async (url, options) => {
    calls++;
    assert.equal(url, 'https://agents.lumalabs.ai/v1/generations');
    assert.equal(options.headers.authorization, 'Bearer private');
    return Response.json(payload, { status: 201 });
  }, 'private', 'generations', { method: 'POST', body: '{}' });
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
    const contract = (await db.query(
      'select model,audio_required from public.ai_video_draft_jobs where id=$1', [first])).rows[0];
    assert.equal(contract.model, 'ray-3.2');
    assert.equal(contract.audio_required, true);
    await assert.rejects(db.query(`insert into public.ai_video_draft_jobs
      (user_id,request_id,request_hash,prompt,aspect_ratio,audio_required)
      values ($1,$2,$3,$4,'16:9',false)`,
      [users[6], '10000000-0000-4000-8000-000000000099', 'b'.repeat(64), prompt]),
    /audio_required/);
    await assert.rejects(insert(0, 1), /AI_VIDEO_USER_DAILY_LIMIT/);
    await assert.rejects(db.query('update public.ai_video_draft_jobs set prompt=$1 where id=$2',
      ['changed text longer than twelve', first]), /AI_VIDEO_REQUEST_IMMUTABLE/);
    await assert.rejects(db.query('update public.ai_video_draft_jobs set audio_required=false where id=$1',
      [first]), /AI_VIDEO_REQUEST_IMMUTABLE|audio_required/);
    for (let n = 1; n < 5; n++) await insert(n);
    await assert.rejects(insert(5), /AI_VIDEO_GLOBAL_DAILY_LIMIT/);

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [users[0]]);
    await db.exec('set role authenticated');
    const visible = await db.query('select id,status from public.ai_video_draft_jobs');
    assert.deepEqual(visible.rows.map((r) => r.id), [first]);
    await assert.rejects(db.query('select provider_output_url from public.ai_video_draft_jobs'), /permission denied/);
    await assert.rejects(db.query('select prompt from public.ai_video_draft_jobs'), /permission denied/);
    await assert.rejects(insert(6), /permission denied/);
  } finally { await db.close(); }
});

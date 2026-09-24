import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { Image } from 'imagescript';
import { loadOwnedImage } from '../supabase/functions/_shared/storage-scan-policy.ts';

const source = readFileSync(new URL('../supabase/functions/generate-ai-image/index.ts', import.meta.url), 'utf8');
const script = new vm.Script(`'use strict';\n${stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''))}`);
const landscape = readFileSync(new URL('./fixtures/images/openai_1088x608.jpg', import.meta.url));
const square = readFileSync(new URL('./fixtures/images/openai_816x816.jpg', import.meta.url));
const oldLandscape = readFileSync(new URL('./fixtures/images/openai_1280x720.jpg', import.meta.url));
const oldSquare = readFileSync(new URL('./fixtures/images/openai_1024x1024.jpg', import.meta.url));
const good = { data: [{ b64_json: landscape.toString('base64') }],
  output_format: 'jpeg', size: '1088x608' };
const allowPolicy = { status: 'completed', output: [
  { type: 'reasoning', summary: [] },
  { type: 'message', role: 'assistant', status: 'completed', content: [
    { type: 'output_text', text: JSON.stringify({ decision: 'allow', reason: 'none' }) },
  ] },
] };
const requestId = '00000000-0000-4000-8000-000000000321';
const owner = '00000000-0000-4000-8000-000000000001';
const origin = 'http://localhost:8000';

function fixture({ reservation = 'reserved', provider = good, project = 'https://nccqnrcdygujulrnwair.supabase.co',
                   enabled = 'true', user = { id: owner, app_metadata: { ai_image_adult_test_approved: true } },
                   providerStatus = 200, apiKey = 'private-openai-test-key',
                   policy = allowPolicy, failPostUpload = false,
                   uploadOutcomes = {},
                   finalizeOutcome = 'success', failureOutcome = 'success',
                   reconcileOutcome = 'authoritative' } = {}) {
  const calls = { provider: [], policy: [], rpc: [], uploads: [], storageReads: [],
    signs: [], updates: [], removes: [], reconciles: 0 };
  let handler;
  let jobStatus = reservation;
  let outputPath = `${owner}/${requestId}.jpg`;
  const storedObjects = new Map();
  let authoritativeDraft = reservation === 'completed'
    ? { status: 'completed', post_path: `${owner}/${requestId}.post.jpg` }
    : { status: reservation };
  const bucket = {
    async upload(path, bytes, options) {
      calls.uploads.push({ path, bytes, options });
      const key = path.endsWith('.post.jpg') ? 'post' : 'output';
      const outcome = uploadOutcomes[key] ??
        (failPostUpload && key === 'post' ? 'error' : 'success');
      if (['success','commit_then_error','commit_then_throw','mismatch'].includes(outcome)) {
        const stored = Uint8Array.from(bytes);
        if (outcome === 'mismatch') stored[stored.length - 1] ^= 1;
        storedObjects.set(path, stored);
      }
      if (outcome === 'commit_then_throw') throw new Error('upload response lost after commit');
      return { error: ['error','commit_then_error','mismatch'].includes(outcome) ?
        { message: 'temporary private upload failure' } : null };
    },
    async info(path) {
      calls.storageReads.push(['info', path]);
      const bytes = storedObjects.get(path);
      return bytes
        ? { data: { size: bytes.byteLength, contentType: 'image/jpeg' }, error: null }
        : { data: null, error: { message: 'not found' } };
    },
    async download(path) {
      calls.storageReads.push(['download', path]);
      const bytes = storedObjects.get(path);
      return bytes
        ? { data: new Blob([bytes]), error: null }
        : { data: null, error: { message: 'not found' } };
    },
    async createSignedUrl(path) {
      calls.signs.push(path);
      return { data: { signedUrl: 'https://nccqnrcdygujulrnwair.supabase.co/storage/v1/object/sign/ai-image-drafts/draft?token=private' }, error: null };
    },
    async remove(paths) {
      calls.removes.push(paths);
      for (const path of paths) storedObjects.delete(path);
      return { error: null };
    },
  };
  const admin = {
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      return { data: [{ reservation_status: jobStatus, draft_path: jobStatus === 'completed' ? outputPath : null }], error: null };
    },
    storage: { from(name) { assert.equal(name, 'ai-image-drafts'); return bucket; } },
    from(name) {
      assert.equal(name, 'ai_image_draft_requests');
      let updatePayload = null;
      const chain = {
        update(payload) {
          calls.updates.push(payload);
          updatePayload = payload;
          if (payload.status === 'completed' &&
              ['success','commit_then_throw','commit_then_error'].includes(finalizeOutcome)) {
            jobStatus = 'completed';
            authoritativeDraft = { ...payload };
          } else if (payload.status === 'failed' &&
              ['success','commit_then_error','commit_then_throw'].includes(failureOutcome)) {
            jobStatus = 'failed';
            authoritativeDraft = { status: 'failed' };
          }
          return chain;
        },
        eq() { return chain; },
        select() { return chain; },
        async maybeSingle() {
          if (updatePayload?.status === 'completed') {
            if (finalizeOutcome === 'commit_then_throw') throw new Error('response lost after commit');
            if (finalizeOutcome === 'throw') throw new Error('write outcome unknown');
            if (finalizeOutcome === 'error' || finalizeOutcome === 'commit_then_error') {
              return { data: null, error: { message: 'FetchError: fetch failed', code: '' } };
            }
            if (finalizeOutcome === 'empty') return { data: null, error: null };
            return { data: { request_id: requestId }, error: null };
          }
          if (updatePayload?.status === 'failed') {
            if (failureOutcome === 'commit_then_throw' || failureOutcome === 'throw') {
              throw new Error('failure update response lost');
            }
            if (failureOutcome === 'commit_then_error' || failureOutcome === 'error') {
              return { data: null, error: { message: 'failure update unavailable' } };
            }
            if (failureOutcome === 'empty') return { data: null, error: null };
            return { data: { status: 'failed' }, error: null };
          }
          calls.reconciles++;
          if (reconcileOutcome === 'throw') throw new Error('authoritative read unavailable');
          if (reconcileOutcome === 'error') return { data: null, error: { message: 'read unavailable' } };
          if (reconcileOutcome === 'mismatch') {
            return { data: { ...authoritativeDraft, post_sha256: '0'.repeat(64) }, error: null };
          }
          return { data: authoritativeDraft, error: null };
        },
        async single() { return { data: { post_path: `${owner}/${requestId}.post.jpg` }, error: null }; },
        then(resolve, reject) { return Promise.resolve({ error: null }).then(resolve, reject); },
      };
      return chain;
    },
  };
  const env = {
    SUPABASE_URL: project, SUPABASE_ANON_KEY: 'anon-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test-key', OPENAI_API_KEY: apiKey,
    ADBATTLE_AI_IMAGE_ENABLED: enabled,
  };
  const context = vm.createContext({
    Deno: { env: { get: name => env[name] }, serve: fn => { handler = fn; } },
    createClient: (_url, key) => key === 'anon-test-key' ?
      { auth: { async getUser() { return { data: { user }, error: null }; } } } : admin,
    corsPreflightResponse: () => new Response(null, { status: 204 }),
    jsonResponse: (_req, body, status = 200) => Response.json(body, { status }),
    parseBearerToken: req => req.headers.get('authorization')?.replace(/^Bearer /, ''),
    fetch: async (url, options) => {
      if (url === 'https://api.openai.com/v1/responses') {
        calls.policy.push({ body: JSON.parse(options.body), headers: options.headers });
        return Response.json(policy);
      }
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      calls.provider.push({ body: JSON.parse(options.body), headers: options.headers });
      return Response.json(provider, { status: providerStatus });
    },
    Request, Response, URL, Blob, AbortSignal, Uint8Array, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, atob, Image, loadOwnedImage, console: { error() {} },
  });
  script.runInContext(context);
  return {
    calls,
    async run(overrides = {}) {
      const headers = {
        origin, authorization: 'Bearer test-token', 'content-type': 'application/json',
        ...overrides.headers,
      };
      const request = new Request(project + '/functions/v1/generate-ai-image', {
        method: 'POST', headers, body: JSON.stringify({
          request_id: requestId, prompt: 'Two dinosaurs on Mars', style: 'pixel_art',
          aspect_ratio: '16:9', ...overrides.body,
        }),
      });
      const response = await handler(request);
      return { status: response.status, cacheControl: response.headers.get('cache-control'),
        body: await response.json() };
    },
  };
}

test('eligible staging creator requests one low-quality image and stores private draft only', async () => {
  const app = fixture();
  const result = await app.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'completed');
  assert.equal(result.cacheControl, 'private, no-store');
  assert.equal(app.calls.rpc.length, 1);
  assert.equal(app.calls.rpc[0].name, 'reserve_ai_image_draft');
  assert.equal(app.calls.rpc[0].args.p_user_limit, 3);
  assert.equal(app.calls.rpc[0].args.p_global_limit, 30);
  assert.equal(app.calls.rpc[0].args.p_aspect_ratio, '16:9');
  assert.equal(app.calls.provider.length, 1);
  assert.equal(app.calls.policy.length, 1);
  assert.equal(app.calls.policy[0].body.store, false);
  assert.equal(app.calls.policy[0].headers.authorization, 'Bearer private-openai-test-key');
  const payload = app.calls.provider[0].body;
  assert.equal(payload.model, 'gpt-image-2.5-flare');
  assert.equal(payload.size, '1088x608');
  assert.equal(payload.quality, 'low');
  assert.equal(payload.n, 1);
  assert.equal(payload.output_format, 'jpeg');
  assert.equal(payload.moderation, 'auto');
  assert.equal(payload.background, 'opaque');
  assert.match(payload.prompt, /Coarse, readable pixel art/);
  assert.equal(app.calls.provider[0].headers.authorization, 'Bearer private-openai-test-key');
  assert.ok(!Object.hasOwn(payload, 'response_format'));
  assert.ok(!Object.hasOwn(payload, 'style'));
  assert.equal(app.calls.uploads[0].path, `${owner}/${requestId}.jpg`);
  assert.equal(app.calls.uploads[0].options.upsert, false);
  assert.equal(app.calls.uploads[1].path, `${owner}/${requestId}.post.jpg`);
  assert.equal(app.calls.uploads[1].options.upsert, false);
  assert.equal(app.calls.uploads[1].options.contentType, 'image/jpeg');
  assert.ok(app.calls.uploads[1].bytes.length <= 500 * 1024);
  const posted = await Image.decode(app.calls.uploads[1].bytes);
  assert.deepEqual([posted.width, posted.height], [640, 360]);
  const left = posted.getRGBAAt(4, 180);
  const right = posted.getRGBAAt(635, 180);
  assert.ok(left[0] > 150 && left[2] < 80, 'left edge of full source remains visible');
  assert.ok(right[2] > 150 && right[0] < 80, 'right edge of full source remains visible');
  assert.equal(app.calls.updates[0].post_bytes, app.calls.uploads[1].bytes.length);
  assert.equal(app.calls.updates[0].post_sha256,
    Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', app.calls.uploads[1].bytes)).toString('hex'));
  assert.equal(app.calls.signs[0], `${owner}/${requestId}.post.jpg`);
  assert.equal(app.calls.signs.length, 1);
  assert.ok(!source.includes('ad-images'));
});

test('replays, caps, ineligible accounts and wrong environment never call image model', async () => {
  for (const [status, expected] of [['completed',200],['reserved_replay',409],['active',409],
    ['user_limit',429],['global_limit',429],['failed',409],['unknown',409]]) {
    const app = fixture({ reservation: status });
    const result = await app.run();
    assert.equal(result.status, expected);
    if (status === 'completed') assert.equal(result.cacheControl, 'private, no-store');
    if (status === 'failed') assert.equal(result.body.error, 'GENERATION_FAILED');
    assert.equal(app.calls.provider.length, 0);
  }
  for (const config of [{ enabled: 'false' }, { project: 'https://production.supabase.co' }]) {
    const app = fixture(config);
    assert.equal((await app.run()).status, 503);
    assert.equal(app.calls.rpc.length, 0);
  }
  const anonymous = fixture({ user: { id: owner, is_anonymous: true } });
  assert.equal((await anonymous.run()).status, 401);
  assert.equal(anonymous.calls.rpc.length, 0);
  assert.equal(anonymous.calls.provider.length, 0);
  const ineligible = fixture({ user: { id: owner,
    user_metadata: { ai_image_adult_test_approved: true } } });
  assert.equal((await ineligible.run()).status, 403);
  assert.equal(ineligible.calls.rpc.length, 0);
  assert.equal(ineligible.calls.provider.length, 0);
  const missingKey = fixture({ apiKey: '' });
  assert.equal((await missingKey.run()).status, 503);
  assert.equal(missingKey.calls.rpc.length, 0);
  const app = fixture();
  assert.equal((await app.run({ body: { style: 'photorealistic' } })).status, 400);
  assert.equal((await app.run({ body: { aspect_ratio: '4:3' } })).status, 400);
  assert.equal((await app.run({ body: { prompt: 'x'.repeat(401) } })).status, 400);
  assert.equal((await app.run({ headers: { origin: 'https://adbattle.io' } })).status, 403);
  assert.equal(app.calls.provider.length, 0);
});

test('malformed, wrong-size or duplicate provider images fail closed and consume reservation', async () => {
  for (const provider of [
    { data: [] },
    { data: [{ b64_json: landscape.toString('base64') }, { b64_json: landscape.toString('base64') }] },
    { data: [{ b64_json: square.toString('base64') }] },
    { data: [{ b64_json: oldLandscape.toString('base64') }] },
    { data: [{ b64_json: 'not base64!' }] },
    { ...good, output_format: 'png' },
    { ...good, size: '1280x720' },
  ]) {
    const app = fixture({ provider });
    const result = await app.run();
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'GENERATION_FAILED');
    assert.equal(app.calls.uploads.length, 0);
    assert.ok(app.calls.updates.some(update => update.status === 'failed'));
  }
});

test('held, rejected, or malformed prompt policy never reaches paid image model', async () => {
  for (const value of [
    { decision: 'hold', reason: 'regulated' },
    { decision: 'reject', reason: 'prohibited' },
    { decision: 'allow', reason: 'uncertain' },
  ]) {
    const policy = structuredClone(allowPolicy);
    policy.output[1].content[0].text = JSON.stringify(value);
    const app = fixture({ policy });
    assert.equal((await app.run()).status, value.decision === 'allow' ? 503 : 422);
    assert.equal(app.calls.policy.length, 1);
    assert.equal(app.calls.provider.length, 0);
    assert.equal(app.calls.uploads.length, 0);
  }
});

test('square request uses supported square size and accepts its image', async () => {
  const app = fixture({ provider: { data: [{ b64_json: square.toString('base64') }] } });
  const result = await app.run({ body: { aspect_ratio: '1:1', style: 'hand_drawn' } });
  assert.equal(result.status, 200);
  assert.equal(app.calls.provider[0].body.size, '816x816');
  assert.match(app.calls.provider[0].body.prompt, /Loose hand-drawn lines/);
  const posted = await Image.decode(app.calls.uploads[1].bytes);
  assert.deepEqual([posted.width, posted.height], [640, 640]);
  const oldSize = fixture({ provider: { data: [{ b64_json: oldSquare.toString('base64') }] } });
  assert.equal((await oldSize.run({ body: { aspect_ratio: '1:1' } })).status, 503);
  assert.equal(oldSize.calls.uploads.length, 0);
});

test('freeform prompt permits detailed fictional imagery under the same output limits', async () => {
  const app = fixture();
  const request = 'A detailed photorealistic scene of a fictional dragon in a toy shop';
  const result = await app.run({ body: { prompt: request, style: 'freeform_simple' } });
  assert.equal(result.status, 200);
  assert.match(app.calls.provider[0].body.prompt, /Follow the creator's own visual style direction/);
  assert.match(app.calls.provider[0].body.prompt, /detailed photorealistic scene/);
  assert.equal(app.calls.provider[0].body.quality, 'low');
  assert.ok(!app.calls.provider[0].body.prompt.includes('no photographic fine texture'));
});

test('provider error consumes the reservation without uploading or retrying', async () => {
  const app = fixture({ providerStatus: 429 });
  const result = await app.run();
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'GENERATION_FAILED');
  assert.equal(app.calls.provider.length, 1);
  assert.equal(app.calls.uploads.length, 0);
  assert.ok(app.calls.updates.some(update => update.status === 'failed'));
});

test('lost failure-state response is terminal only when an authoritative read proves failed', async () => {
  const committed = fixture({ providerStatus: 429, failureOutcome: 'commit_then_error' });
  const committedResult = await committed.run();
  assert.equal(committedResult.status, 503);
  assert.equal(committedResult.body.error, 'GENERATION_FAILED');

  const unknown = fixture({ providerStatus: 429, failureOutcome: 'error' });
  const unknownResult = await unknown.run();
  assert.equal(unknownResult.status, 503);
  assert.equal(unknownResult.body.error, 'GENERATION_OUTCOME_UNCERTAIN');
  assert.equal(unknown.calls.updates.filter(update => update.status === 'failed').length, 1);

  const heldPolicy = structuredClone(allowPolicy);
  heldPolicy.output[1].content[0].text = JSON.stringify({ decision: 'hold', reason: 'regulated' });
  const uncertainHold = fixture({ policy: heldPolicy, failureOutcome: 'error' });
  const holdResult = await uncertainHold.run();
  assert.equal(holdResult.status, 503);
  assert.equal(holdResult.body.error, 'GENERATION_OUTCOME_UNCERTAIN');
});

test('canonical decode and second private upload failures never complete a draft', async () => {
  const truncated = landscape.subarray(0, 200);
  const invalid = fixture({ provider: { data: [{ b64_json: truncated.toString('base64') }] } });
  assert.equal((await invalid.run()).status, 503);
  assert.equal(invalid.calls.uploads.length, 0);
  const failed = fixture({ failPostUpload: true });
  assert.equal((await failed.run()).status, 503);
  assert.deepEqual(failed.calls.removes, []);
  assert.ok(failed.calls.updates.every(update => update.status !== 'completed'));
});

test('commit-then-error draft uploads reconcile exact deterministic objects', async () => {
  const app = fixture({ uploadOutcomes: {
    output: 'commit_then_error', post: 'commit_then_throw',
  } });
  const result = await app.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'completed');
  assert.equal(app.calls.uploads.length, 2);
  assert.deepEqual(app.calls.storageReads.map(([operation, path]) => [operation, path]), [
    ['info', `${owner}/${requestId}.jpg`],
    ['download', `${owner}/${requestId}.jpg`],
    ['info', `${owner}/${requestId}.post.jpg`],
    ['download', `${owner}/${requestId}.post.jpg`],
  ]);
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'completed').length, 1);
});

test('draft upload error with different existing bytes fails closed without deletion', async () => {
  for (const target of ['output', 'post']) {
    const app = fixture({ uploadOutcomes: { [target]: 'mismatch' } });
    const result = await app.run();
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'GENERATION_FAILED');
    assert.equal(app.calls.uploads.length, target === 'output' ? 1 : 2);
    assert.deepEqual(app.calls.removes, []);
    assert.equal(app.calls.updates.filter(update => update.status === 'completed').length, 0);
    assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 1);
  }
});

test('lost finalization response preserves committed draft and replay never calls provider twice', async () => {
  const app = fixture({ finalizeOutcome: 'commit_then_throw' });
  const first = await app.run();
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'completed');
  assert.equal(first.cacheControl, 'private, no-store');
  assert.equal(app.calls.reconciles, 1);
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 0);

  const replay = await app.run();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'completed');
  assert.equal(replay.cacheControl, 'private, no-store');
  assert.equal(app.calls.provider.length, 1);
  assert.equal(app.calls.uploads.length, 2);
});

test('committed completion followed by a returned PostgREST error reconciles and retains both objects', async () => {
  const app = fixture({ finalizeOutcome: 'commit_then_error' });
  const result = await app.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'completed');
  assert.equal(app.calls.reconciles, 1);
  assert.deepEqual(app.calls.uploads.map(({ path }) => path), [
    `${owner}/${requestId}.jpg`,
    `${owner}/${requestId}.post.jpg`,
  ]);
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 0);
});

test('unknown finalization state retains both private objects and does not mark request failed', async () => {
  const app = fixture({ finalizeOutcome: 'error', reconcileOutcome: 'error' });
  const result = await app.run();
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'GENERATION_OUTCOME_UNCERTAIN');
  assert.equal(app.calls.reconciles, 1);
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 0);
  assert.equal(app.calls.provider.length, 1);
});

test('transport-lost finalization with a reserved read still retains both objects', async () => {
  const app = fixture({ finalizeOutcome: 'throw' });
  const result = await app.run();
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'GENERATION_OUTCOME_UNCERTAIN');
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 0);
  assert.equal(app.calls.provider.length, 1);
});

test('returned PostgREST fetch error is also uncertain and retains both objects', async () => {
  const app = fixture({ finalizeOutcome: 'error' });
  const result = await app.run();
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'GENERATION_OUTCOME_UNCERTAIN');
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 0);
});

test('completed row with conflicting metadata is inconclusive and never triggers deletion', async () => {
  const app = fixture({ finalizeOutcome: 'commit_then_throw', reconcileOutcome: 'mismatch' });
  const result = await app.run();
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'GENERATION_OUTCOME_UNCERTAIN');
  assert.deepEqual(app.calls.removes, []);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 0);
});

test('definitively uncommitted finalization cleans both objects and consumes request', async () => {
  const app = fixture({ finalizeOutcome: 'empty' });
  assert.equal((await app.run()).status, 503);
  assert.deepEqual(Array.from(app.calls.removes[0]), [
    `${owner}/${requestId}.jpg`, `${owner}/${requestId}.post.jpg`,
  ]);
  assert.equal(app.calls.updates.filter(update => update.status === 'failed').length, 1);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../supabase/functions/generate-ai-image/index.ts', import.meta.url), 'utf8');
const script = new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, '')));
const landscape = readFileSync(new URL('./fixtures/images/openai_1280x720.jpg', import.meta.url));
const square = readFileSync(new URL('./fixtures/images/openai_1024x1024.jpg', import.meta.url));
const good = { data: [{ b64_json: landscape.toString('base64') }],
  output_format: 'jpeg', size: '1280x720' };
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
                   policy = allowPolicy } = {}) {
  const calls = { provider: [], policy: [], rpc: [], uploads: [], signs: [], updates: [] };
  let handler;
  let jobStatus = reservation;
  let outputPath = `${owner}/${requestId}.jpg`;
  const bucket = {
    async upload(path, bytes, options) {
      calls.uploads.push({ path, bytes, options });
      return { error: null };
    },
    async createSignedUrl(path) {
      calls.signs.push(path);
      return { data: { signedUrl: 'https://nccqnrcdygujulrnwair.supabase.co/storage/v1/object/sign/ai-image-drafts/draft?token=private' }, error: null };
    },
    async remove() { return { error: null }; },
  };
  const admin = {
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      return { data: [{ reservation_status: jobStatus, draft_path: jobStatus === 'completed' ? outputPath : null }], error: null };
    },
    storage: { from(name) { assert.equal(name, 'ai-image-drafts'); return bucket; } },
    from(name) {
      assert.equal(name, 'ai_image_draft_requests');
      const chain = {
        update(payload) { calls.updates.push(payload); if (payload.status) jobStatus = payload.status; return chain; },
        eq() { return chain; },
        select() { return chain; },
        async maybeSingle() { return { data: { request_id: requestId }, error: null }; },
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
    crypto: globalThis.crypto, atob, console: { error() {} },
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
      return { status: response.status, body: await response.json() };
    },
  };
}

test('eligible staging creator requests one low-quality image and stores private draft only', async () => {
  const app = fixture();
  const result = await app.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'completed');
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
  assert.equal(payload.size, '1280x720');
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
  assert.equal(app.calls.signs.length, 1);
  assert.ok(!source.includes('ad-images'));
});

test('replays, caps, ineligible accounts and wrong environment never call image model', async () => {
  for (const [status, expected] of [['completed',200],['reserved_replay',409],['active',409],
    ['user_limit',429],['global_limit',429],['failed',409],['unknown',409]]) {
    const app = fixture({ reservation: status });
    assert.equal((await app.run()).status, expected);
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
    { data: [{ b64_json: 'not base64!' }] },
    { ...good, output_format: 'png' },
    { ...good, size: '1024x1024' },
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
  assert.equal(app.calls.provider[0].body.size, '1024x1024');
  assert.match(app.calls.provider[0].body.prompt, /Loose hand-drawn lines/);
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
  assert.equal((await app.run()).status, 503);
  assert.equal(app.calls.provider.length, 1);
  assert.equal(app.calls.uploads.length, 0);
  assert.ok(app.calls.updates.some(update => update.status === 'failed'));
});

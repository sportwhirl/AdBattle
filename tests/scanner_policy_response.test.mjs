import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual Edge handler with mocked I/O; no live keys or API calls.
const source = readFileSync(new URL('../supabase/functions/scan-ad/index.ts', import.meta.url), 'utf8');
const script = new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/, '')));
const image = readFileSync(new URL('./fixtures/images/valid.png', import.meta.url));
const approval = {
  decision: 'approve', hard_violation: false, confidence: 0.99, risk_score: 1,
  categories: ['none'], reasons: ['Ordinary benign ad.'], requires_ad_network_review: false,
};
const message = (content) => ({ type: 'message', role: 'assistant', status: 'completed', content });
const textPart = (text) => ({ type: 'output_text', text, annotations: [] });
const completed = (decision = approval) => ({
  status: 'completed', error: null, incomplete_details: null,
  output: [
    { type: 'reasoning', summary: [] },
    message([textPart(JSON.stringify(decision))]),
  ],
});

function scanner(policyResponse, { policyHttpStatus = 200, safetyStatus = 'pending' } = {}) {
  const projectUrl = 'https://test-project.supabase.co';
  const ad = {
    id: 4, user_id: 'test-owner', title: 'Staging upload test', caption: 'A harmless image.',
    image_url: `${projectUrl}/storage/v1/object/public/ad-images/test-owner/image.png`,
    moderation_status: 'pending_scan', safety_status: safetyStatus, moderation_attempts: 1,
  };
  const audits = [], updates = [], rpcCalls = [], requests = [];
  const admin = {
    from(table) {
      assert.ok(['ads', 'moderation_events'].includes(table), `unexpected table: ${table}`);
      let update;
      const chain = {
        select() { return chain; },
        eq(key, value) { assert.equal(key, 'id'); assert.equal(value, ad.id); return chain; },
        in() { return chain; },
        async maybeSingle() { return { data: { ...ad }, error: null }; },
        update(value) { update = value; return chain; },
        async insert(value) { assert.equal(table, 'moderation_events'); audits.push(value); return { error: null }; },
        then(resolve, reject) {
          assert.equal(table, 'ads');
          assert.ok(update);
          updates.push(update);
          Object.assign(ad, update);
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return { error: null };
    },
  };
  let handler;
  const env = {
    SUPABASE_URL: projectUrl, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    SCANNER_WEBHOOK_SECRET: 'test-webhook-secret', OPENAI_API_KEY: 'test-openai-key',
  };
  const context = vm.createContext({
    Deno: { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } },
    createClient: () => admin,
    Request, Response, URL, TextEncoder, AbortController, Uint8Array, crypto: globalThis.crypto,
    setTimeout, clearTimeout, btoa, console: { error() {} },
    fetch: async (url, options = {}) => {
      if (url === ad.image_url) return new Response(image, { headers: { 'content-type': 'image/png' } });
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url === 'https://api.openai.com/v1/moderations') {
        return Response.json({ results: [{ flagged: false, category_scores: {}, categories: {} }] });
      }
      assert.equal(url, 'https://api.openai.com/v1/responses');
      return Response.json(policyResponse, { status: policyHttpStatus });
    },
  });
  script.runInContext(context);
  return {
    context, ad, audits, updates, rpcCalls, requests,
    async run(secret = env.SCANNER_WEBHOOK_SECRET) {
      const response = await handler(new Request(`${projectUrl}/functions/v1/scan-ad`, {
        method: 'POST', headers: { 'x-adbattle-scanner-secret': secret },
        body: JSON.stringify({ record: { id: ad.id } }),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

test('raw REST policy output reaches the existing safety gate after reasoning items', async () => {
  const s = scanner(completed());
  const response = await s.run();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'approved');
  assert.equal(s.rpcCalls.length, 1);
  assert.equal(s.rpcCalls[0].name, 'record_ad_safety_scan');
  assert.equal(s.rpcCalls[0].args.p_ad_id, 4);
  assert.equal(s.rpcCalls[0].args.p_status, 'passed');
  assert.ok(s.audits.some((row) => row.stage === 'ad_policy_review' && row.outcome === 'approve'));
  assert.ok(s.updates.every((row) => !('moderation_status' in row) && !('safety_status' in row)));
  const request = s.requests.find((row) => row.url.endsWith('/responses')).body;
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.max_output_tokens, 700);
});

test('raw text parts are concatenated, without reading an SDK output_text property', async () => {
  const body = completed();
  const json = JSON.stringify(approval);
  body.output[1].content = [textPart(json.slice(0, 25)), textPart(json.slice(25))];
  body.output_text = 'This field is not authoritative.';
  const s = scanner(body);
  assert.equal((await s.run()).body.status, 'approved');
});

test('valid manual review and high-confidence rejection retain their safety decisions', async () => {
  for (const [decision, expected] of [['manual_review', 'held'], ['reject', 'failed']]) {
    const s = scanner(completed({ ...approval, decision, hard_violation: decision === 'reject' }));
    assert.equal((await s.run()).status, 200);
    assert.equal(s.rpcCalls[0].args.p_status, expected);
  }
});

async function assertPending(body, pattern, options) {
  const s = scanner(body, options);
  const result = await s.run();
  assert.equal(result.status, 502);
  assert.match(result.body.error, /remains unpublished/);
  assert.match(result.body.details, pattern);
  assert.equal(s.rpcCalls.length, 0);
  assert.equal(s.ad.safety_status, 'pending');
  assert.equal(s.ad.moderation_status, 'pending_scan');
  assert.ok(s.audits.some((row) => row.stage === 'error' && row.outcome === 'temporary_error'));
  assert.ok(!s.audits.some((row) => row.stage === 'final_decision'));
  assert.match(s.ad.moderation_last_error, pattern);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(s.audits), /PRIVATE_SENTINEL/);
}

test('incomplete, failed, missing-status, and inconsistent envelopes never approve even with valid JSON', async () => {
  for (const status of ['incomplete', 'failed', 'queued', 'in_progress', 'cancelled', undefined]) {
    await assertPending({ ...completed(), status }, /did not complete/);
  }
  for (const reason of ['max_output_tokens', 'content_filter']) {
    await assertPending({ ...completed(), status: 'incomplete', incomplete_details: { reason } }, /incomplete/);
  }
  await assertPending({ ...completed(), error: { message: 'PRIVATE_SENTINEL' } }, /did not complete/);
  await assertPending({ ...completed(), incomplete_details: { reason: 'unknown' } }, /did not complete/);
});

test('refusals, absent text, and malformed messages remain pending', async () => {
  const refusal = { type: 'refusal', refusal: 'PRIVATE_SENTINEL' };
  await assertPending({ ...completed(), output: [message([refusal])] }, /refused/);
  await assertPending({ ...completed(), output: [message([textPart(JSON.stringify(approval)), refusal])] }, /refused/);
  for (const output of [[], [{ type: 'reasoning', summary: [] }], [message([textPart(' ')])]]) {
    await assertPending({ ...completed(), output }, /no output text/);
  }
  await assertPending({ ...completed(), output: null }, /invalid output/);
  await assertPending({ ...completed(), output: [{ ...message([]), status: 'incomplete' }] }, /invalid message/);
  await assertPending({ ...completed(), output: [{ ...message([]), role: 'user' }] }, /invalid message/);
  await assertPending({ ...completed(), output: [message([textPart(42)])] }, /invalid message content/);
  await assertPending({ status: 'completed', output_text: JSON.stringify(approval) }, /invalid output/);
});

test('invalid JSON and HTTP failures produce sanitized diagnostics', async () => {
  await assertPending({ ...completed(), output: [message([textPart('PRIVATE_SENTINEL')])] }, /invalid JSON/);
  await assertPending({ error: { message: 'PRIVATE_SENTINEL' } }, /failed \(429\)/, { policyHttpStatus: 429 });
});

test('policy decision schema is validated before any safety decision', async () => {
  for (const value of [null, [], true, {},
    { ...approval, decision: 'APPROVE' }, { ...approval, hard_violation: 'false' },
    { ...approval, requires_ad_network_review: null }, { ...approval, confidence: '0.99' },
    { ...approval, confidence: -1 }, { ...approval, confidence: 2 },
    { ...approval, risk_score: 1.5 }, { ...approval, risk_score: 101 },
    { ...approval, categories: ['unknown'] }, { ...approval, categories: 'none' },
    { ...approval, categories: Array(9).fill('none') },
    { ...approval, reasons: [false] }, { ...approval, reasons: ['x'.repeat(241)] },
    { ...approval, reasons: Array(7).fill('reason') },
    { ...approval, extra: 'PRIVATE_SENTINEL' },
  ]) await assertPending(completed(value), /invalid decision/);
  const missing = { ...approval }; delete missing.confidence;
  await assertPending(completed(missing), /invalid decision/);
});

test('contradictory approvals remain pending for investigation', async () => {
  await assertPending(completed({ ...approval, hard_violation: true }), /conflicting approval/);
  await assertPending(completed({ ...approval, requires_ad_network_review: true }), /conflicting approval/);
});

test('terminal decisions and invalid webhook credentials skip OpenAI', async () => {
  const terminal = scanner(completed(), { safetyStatus: 'passed' });
  assert.equal((await terminal.run()).body.skipped, true);
  assert.equal(terminal.requests.length, 0);
  const unauthorized = scanner(completed());
  assert.equal((await unauthorized.run('wrong-secret')).status, 401);
  assert.equal(unauthorized.requests.length, 0);
  assert.equal(unauthorized.rpcCalls.length, 0);
});

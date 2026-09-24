import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { requireSupportedImage } from '../supabase/functions/_shared/storage-scan-policy.ts';

// Execute the actual Edge handler with mocked I/O; no live keys or API calls.
const source = readFileSync(new URL('../supabase/functions/scan-ad/index.ts', import.meta.url), 'utf8');
const script = new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, '')));
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

function scanner(policyResponse, {
  policyHttpStatus = 200, safetyStatus = 'pending',
  loseClaimResponse = false, loseFinalizeResponse = false,
} = {}) {
  const projectUrl = 'https://test-project.supabase.co';
  const ad = {
    id: 4, user_id: 'test-owner', title: 'Staging upload test', caption: 'A harmless image.',
    image_url: '', image_storage_path: 'test-owner/image.png',
    moderation_status: 'pending_scan', safety_status: safetyStatus, moderation_attempts: 1,
  };
  const audits = [], updates = [], rpcCalls = [], requests = [];
  let activeClaim = null;
  let claimResponseLost = false;
  let finalResponseLost = false;
  let finalRecord = null;
  const admin = {
    storage: { from(bucket) { assert.equal(bucket, 'ad-pending-images'); return {}; } },
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
      if (name === 'claim_ad_safety_scan') {
        let data;
        if (ad.safety_status !== 'pending') {
          data = { result:'terminal', safety_status:ad.safety_status };
        } else if (activeClaim === args.p_claim_token) {
          data = { result:'claimed', replayed:true, lease_expires_at:'2099-01-01T00:00:00Z' };
        } else if (activeClaim) {
          data = { result:'busy', lease_expires_at:'2099-01-01T00:00:00Z' };
        } else {
          activeClaim = args.p_claim_token;
          ad.moderation_attempts += 1;
          ad.moderation_last_error = null;
          ad.moderation_scan_version = args.p_scan_version;
          data = { result:'claimed', replayed:false, lease_expires_at:'2099-01-01T00:00:00Z' };
        }
        if (loseClaimResponse && !claimResponseLost && data.result === 'claimed') {
          claimResponseLost = true;
          throw new Error('claim response connection reset');
        }
        return { data, error:null };
      }
      if (name === 'finalize_ad_safety_scan') {
        const payload = JSON.stringify(args);
        if (ad.safety_status !== 'pending') {
          if (finalRecord?.token === args.p_claim_token && finalRecord.payload === payload) {
            return { data:{ ...finalRecord.result, result:'replayed' }, error:null };
          }
          return { data:null, error:{ message:'SAFETY_FINALIZATION_CONFLICT' } };
        }
        if (activeClaim !== args.p_claim_token) {
          return { data:null, error:{ message:'SAFETY_SCAN_CLAIM_LOST' } };
        }
        ad.safety_status = args.p_status;
        ad.moderation_status = args.p_status === 'failed' ? 'rejected' :
          args.p_status === 'held' ? 'pending_scan' : 'approved';
        ad.moderation_reason = args.p_reason;
        ad.moderation_details = args.p_details;
        ad.moderation_risk_score = args.p_risk_score;
        ad.moderation_image_sha256 = args.p_image_sha256;
        ad.moderation_scan_version = args.p_scan_version;
        const result = {
          result:'finalized', safety_status:ad.safety_status,
          moderation_status:ad.moderation_status,
        };
        finalRecord = { token:args.p_claim_token, payload, result };
        audits.push({
          ad_id:ad.id, stage:'final_decision',
          outcome:args.p_status === 'passed' ? 'approved' :
            args.p_status === 'held' ? 'manual_review' : 'rejected',
          reason:args.p_reason,
          details:{ risk_score:args.p_risk_score, image_sha256:args.p_image_sha256 },
        });
        if (loseFinalizeResponse && !finalResponseLost) {
          finalResponseLost = true;
          throw new Error('finalize response connection reset');
        }
        return { data:result, error:null };
      }
      if (name === 'record_ad_safety_scan_failure') {
        let data;
        if (ad.safety_status !== 'pending') {
          data = { result:'terminal', safety_status:ad.safety_status };
        } else if (activeClaim !== args.p_claim_token) {
          data = { result:'claim_lost' };
        } else {
          ad.moderation_last_error = args.p_error;
          activeClaim = null;
          audits.push({
            ad_id:ad.id, stage:'error', outcome:'temporary_error',
            reason:args.p_error, details:null,
          });
          data = { result:'released' };
        }
        return { data, error:null };
      }
      assert.fail(`unexpected RPC: ${name}`);
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
    loadOwnedImage: async (_bucket, owner, path) => {
      assert.equal(owner, ad.user_id);
      assert.equal(path, ad.image_storage_path);
      return new Uint8Array(image);
    },
    requireSupportedImage,
    Request, Response, URL, TextEncoder, AbortController, Uint8Array, crypto: globalThis.crypto,
    setTimeout, clearTimeout, btoa, console: { error() {} },
    fetch: async (url, options = {}) => {
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
  const finalCall = s.rpcCalls.find(({ name }) => name === 'finalize_ad_safety_scan');
  assert.ok(finalCall);
  assert.equal(finalCall.args.p_ad_id, 4);
  assert.equal(finalCall.args.p_status, 'passed');
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
    assert.equal(s.rpcCalls.find(({ name }) => name === 'finalize_ad_safety_scan').args.p_status, expected);
  }
});

async function assertPending(body, pattern, options) {
  const s = scanner(body, options);
  const result = await s.run();
  assert.equal(result.status, 502);
  assert.match(result.body.error, /remains unpublished/);
  assert.match(result.body.details, pattern);
  assert.ok(s.rpcCalls.some(({ name }) => name === 'claim_ad_safety_scan'));
  assert.ok(s.rpcCalls.some(({ name }) => name === 'record_ad_safety_scan_failure'));
  assert.ok(!s.rpcCalls.some(({ name }) => name === 'finalize_ad_safety_scan'));
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

test('only the lease holder reaches either provider under concurrent delivery', async () => {
  const s = scanner(completed());
  const results = await Promise.all([s.run(),s.run()]);
  assert.deepEqual(results.map(({ status }) => status).sort(),[200,202]);
  assert.equal(results.find(({ status }) => status === 202).body.status,'in_progress');
  assert.equal(s.requests.filter(({ url }) => url.endsWith('/moderations')).length,1);
  assert.equal(s.requests.filter(({ url }) => url.endsWith('/responses')).length,1);
  assert.equal(s.rpcCalls.filter(({ name }) => name === 'finalize_ad_safety_scan').length,1);
});

test('thrown lost claim and finalize responses replay the same token and payload safely', async () => {
  const s = scanner(completed(), { loseClaimResponse:true, loseFinalizeResponse:true });
  const result = await s.run();
  assert.equal(result.status,200);
  assert.equal(result.body.status,'approved');
  const claims = s.rpcCalls.filter(({ name }) => name === 'claim_ad_safety_scan');
  const finalizations = s.rpcCalls.filter(({ name }) => name === 'finalize_ad_safety_scan');
  assert.equal(claims.length,2);
  assert.equal(claims[0].args.p_claim_token,claims[1].args.p_claim_token);
  assert.equal(s.ad.moderation_attempts,2);
  assert.equal(finalizations.length,2);
  assert.deepEqual(finalizations[0].args,finalizations[1].args);
  assert.equal(s.audits.filter(({ stage }) => stage === 'final_decision').length,1);
  assert.equal(s.requests.length,2);
});

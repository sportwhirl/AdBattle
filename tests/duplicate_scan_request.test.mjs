import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DuplicateScanRequestError,
  parseDuplicateScanRequest,
} from '../supabase/functions/_shared/duplicate-scan-request.ts';

const webhookSecret = 'duplicate-webhook-test-secret';
const backfillSecret = 'legacy-backfill-test-secret';
const webhookBody = {
  type: 'INSERT',
  table: 'ads',
  schema: 'public',
  record: { id: 42 },
};

function headers(values = {}) {
  return new Headers(values);
}

function errorFrom(run) {
  assert.throws(run, error => {
    assert.ok(error instanceof DuplicateScanRequestError);
    return true;
  });
  try { run(); } catch (error) { return error; }
}

test('browser does not invoke the private duplicate scanner', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /functions\.invoke\(\s*["']scan-ad-duplicate["']/);
  assert.doesNotMatch(html, /x-adbattle-duplicate-scanner-secret|DUPLICATE_SCANNER_WEBHOOK_SECRET/);
  assert.match(html, /remains pending and private until both safety and duplicate screening/);
});

test('normal webhook requires its own configured private secret', () => {
  for (const supplied of ['', 'wrong-secret']) {
    const error = errorFrom(() => parseDuplicateScanRequest(
      webhookBody,
      headers({ 'x-adbattle-duplicate-scanner-secret': supplied }),
      webhookSecret,
      backfillSecret,
    ));
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.equal(error.status, 401);
  }
  const missingConfig = errorFrom(() => parseDuplicateScanRequest(
    webhookBody,
    headers({ 'x-adbattle-duplicate-scanner-secret': webhookSecret }),
    '',
    backfillSecret,
  ));
  assert.equal(missingConfig.code, 'SERVER_CONFIGURATION_ERROR');
  assert.equal(missingConfig.status, 500);
});

test('valid INSERT webhook extracts only the ad id', () => {
  const result = parseDuplicateScanRequest(
    { ...webhookBody, record: {
      id: 42,
      user_id: 'attacker',
      image_storage_path: 'attacker/foreign.png',
      duplicate_status: 'passed',
    } },
    headers({ 'x-adbattle-duplicate-scanner-secret': webhookSecret }),
    webhookSecret,
    backfillSecret,
  );
  assert.deepEqual(result, { adId: 42, legacyBackfill: false });

  const source = readFileSync(new URL('../supabase/functions/scan-ad-duplicate/index.ts', import.meta.url), 'utf8');
  assert.match(source, /from\("ads"\)[\s\S]*\.select\("id,user_id,image_storage_path,duplicate_status,image_index_required"\)\.eq\("id", adId\)\.single\(\)/);
});

test('non-INSERT or wrong-table webhook payloads are rejected', () => {
  for (const body of [
    { ...webhookBody, type: 'UPDATE' },
    { ...webhookBody, table: 'creator_profiles' },
    { ...webhookBody, schema: 'private' },
    { ...webhookBody, record: { id: 0 } },
  ]) {
    const error = errorFrom(() => parseDuplicateScanRequest(
      body,
      headers({ 'x-adbattle-duplicate-scanner-secret': webhookSecret }),
      webhookSecret,
      backfillSecret,
    ));
    assert.ok(['INVALID_WEBHOOK_PAYLOAD', 'INVALID_AD_ID'].includes(error.code));
  }
});

test('legacy backfill retains its separate secret and request shape', () => {
  const wrong = errorFrom(() => parseDuplicateScanRequest(
    { legacy_ad_id: 91 },
    headers({ 'x-adbattle-duplicate-scanner-secret': webhookSecret }),
    webhookSecret,
    backfillSecret,
  ));
  assert.equal(wrong.code, 'UNAUTHORIZED');

  assert.deepEqual(parseDuplicateScanRequest(
    { legacy_ad_id: 91 },
    headers({ 'x-adbattle-backfill-secret': backfillSecret }),
    webhookSecret,
    backfillSecret,
  ), { adId: 91, legacyBackfill: true });
});

test('scanner errors still call the fail-closed failure RPC', () => {
  const source = readFileSync(new URL('../supabase/functions/scan-ad-duplicate/index.ts', import.meta.url), 'utf8');
  assert.match(source, /record_ad_duplicate_scan_failure/);
  assert.match(source, /error: "SCAN_INCOMPLETE", status: "pending"/);
});

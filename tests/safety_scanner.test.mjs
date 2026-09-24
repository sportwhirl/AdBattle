import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/scan-ad/index.ts', import.meta.url),'utf8');

test('restored safety scanner keeps private webhook auth and authoritative reload', () => {
  assert.match(source,/SCANNER_WEBHOOK_SECRET/);
  assert.match(source,/x-adbattle-scanner-secret/);
  assert.match(source,/\.from\("ads"\)[\s\S]*\.eq\(\s*"id",\s*adId/);
  assert.match(source,/title,[\s\S]*caption,[\s\S]*image_url,[\s\S]*moderation_attempts/);
});

test('restored scanner retains deterministic, OpenAI, policy, and audit stages', () => {
  for (const marker of [
    'text_validation','url_validation','image_validation','openai_moderation',
    'ad_policy_review','moderation_events','moderation_risk_score',
    'moderation_details','moderation_scan_version','moderation_image_sha256',
    'moderation_attempts','moderation_last_error','omni-moderation-latest',
    'https://api.openai.com/v1/responses','manual_review','temporary_error',
  ]) assert.ok(source.includes(marker),`missing historical safety behavior: ${marker}`);
});

test('safety scanner stores its audit hash without performing duplicate decisions', () => {
  assert.match(source,/moderation_image_sha256/);
  assert.match(source,/const imageHash\s*=\s*await sha256Hex/);
  assert.doesNotMatch(source,/duplicate_check|duplicate_signal|otherUserDuplicate|duplicateRows/);
  assert.doesNotMatch(source,/\.eq\(\s*"moderation_image_sha256"/);
  assert.doesNotMatch(source,/duplicate_status|duplicate_of_ad_id|review_identical|review_similar|duplicate_same_creator/);
});

test('final safety decisions use the independent service-only safety gate', () => {
  assert.match(source,/status === "approved"[\s\S]*\? "passed"/);
  assert.match(source,/status === "manual_review"[\s\S]*\? "held"[\s\S]*: "failed"/);
  assert.match(source,/admin\.rpc\(\s*"record_ad_safety_scan"/);
  const finalize = source.slice(source.indexOf('async function finalize'),source.indexOf('async function runOpenAIModeration'));
  assert.doesNotMatch(finalize,/moderation_status\s*:/);
});

test('terminal safety states skip attempts, OpenAI moderation, and policy review', () => {
  const handler=source.slice(source.indexOf('Deno.serve('));
  assert.match(handler,/safety_status,[\s\S]*if \(ad\.safety_status !== "pending"\)/);
  assert.match(handler,/ad\.safety_status === "passed"[\s\S]*ad\.safety_status === "held"/);
  const terminalGuard=handler.indexOf('if (ad.safety_status !== "pending")');
  const attempt=handler.indexOf('await updateAttempt(',terminalGuard);
  const moderation=handler.indexOf('await runOpenAIModeration(',terminalGuard);
  const policy=handler.indexOf('await runAdPolicyReview(',terminalGuard);
  assert.ok(terminalGuard >= 0 && terminalGuard < attempt && attempt < moderation && moderation < policy);
});

test('scanner failure records an error and never approves', () => {
  assert.match(source,/await setScanError\(/);
  assert.match(source,/Scanner temporarily failed\. The ad remains unpublished\./);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/scan-ad/index.ts', import.meta.url),'utf8');

test('safety scanner pins its Supabase client dependency', () => {
  assert.match(source,/from "npm:@supabase\/supabase-js@2\.117\.1"/);
});

test('restored safety scanner keeps private webhook auth and authoritative reload', () => {
  assert.match(source,/SCANNER_WEBHOOK_SECRET/);
  assert.match(source,/x-adbattle-scanner-secret/);
  assert.match(source,/\.from\("ads"\)[\s\S]*\.eq\(\s*"id",\s*adId/);
  assert.match(source,/title,[\s\S]*caption,[\s\S]*image_storage_path,[\s\S]*moderation_attempts/);
  assert.match(source,/loadOwnedImage\([\s\S]*PENDING_IMAGE_BUCKET/);
});

test('restored scanner retains deterministic, OpenAI, policy, and audit stages', () => {
  for (const marker of [
    'text_validation','url_validation','image_validation','openai_moderation',
    'ad_policy_review','moderation_events','p_risk_score',
    'p_details','p_scan_version','p_image_sha256',
    'moderation_attempts','record_ad_safety_scan_failure','omni-moderation-latest',
    'https://api.openai.com/v1/responses','manual_review',
  ]) assert.ok(source.includes(marker),`missing historical safety behavior: ${marker}`);
});

test('safety scanner stores its audit hash without performing duplicate decisions', () => {
  assert.match(source,/p_image_sha256/);
  assert.match(source,/const imageHash\s*=\s*await sha256Hex/);
  assert.doesNotMatch(source,/duplicate_check|duplicate_signal|otherUserDuplicate|duplicateRows/);
  assert.doesNotMatch(source,/\.eq\(\s*"moderation_image_sha256"/);
  assert.doesNotMatch(source,/duplicate_status|duplicate_of_ad_id|review_identical|review_similar|duplicate_same_creator/);
});

test('final safety decisions use the independent token-bound atomic gate', () => {
  assert.match(source,/status === "approved"[\s\S]*\? "passed"/);
  assert.match(source,/status === "manual_review"[\s\S]*\? "held"[\s\S]*: "failed"/);
  assert.match(source,/admin\.rpc\(\s*"finalize_ad_safety_scan"/);
  assert.match(source,/p_claim_token:\s*claimToken/);
  const finalize = source.slice(source.indexOf('async function finalize'),source.indexOf('async function runOpenAIModeration'));
  assert.doesNotMatch(finalize,/\.from\("ads"\)/);
  assert.doesNotMatch(finalize,/moderation_status\s*:/);
});

test('terminal or leased safety states skip both provider calls', () => {
  const handler=source.slice(source.indexOf('Deno.serve('));
  assert.match(handler,/await claimSafetyScan\(/);
  assert.match(handler,/claim\.result ===[\s\S]*"terminal"/);
  assert.match(handler,/claim\.result ===[\s\S]*"busy"/);
  const claim=handler.indexOf('await claimSafetyScan(');
  const terminalGuard=handler.indexOf('claim.result ===',claim);
  const moderation=handler.indexOf('await runOpenAIModeration(',terminalGuard);
  const policy=handler.indexOf('await runAdPolicyReview(',terminalGuard);
  assert.ok(claim >= 0 && claim < terminalGuard && terminalGuard < moderation && moderation < policy);
});

test('scanner failure records an error and never approves', () => {
  assert.match(source,/await setScanError\(/);
  assert.match(source,/Scanner temporarily failed\. The ad remains unpublished\./);
});

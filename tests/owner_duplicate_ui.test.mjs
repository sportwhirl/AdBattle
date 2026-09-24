import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('same-owner duplicate shows a neutral link using duplicate_of_ad_id', () => {
  assert.match(html,/ad\.owner[\s\S]*ad\.duplicateStatus === "duplicate_same_creator"/);
  assert.match(html,/You already posted this image\./);
  assert.match(html,/showExistingAd\(\$\{ad\.duplicateOfAdId\}\)/);
  assert.match(html,/View existing ad #\$\{ad\.duplicateOfAdId\}/);
});

test('owner duplicate details are removed from another viewer model', () => {
  assert.match(html,/const isOwner = Boolean\(loadingUserId && ad\.user_id === loadingUserId\)/);
  assert.match(html,/duplicateStatus:\s*isOwner && FEATURES\.duplicateScreening[\s\S]*\? ad\.duplicate_status \|\| "pending"\s*:\s*null/);
  assert.match(html,/duplicateOfAdId:\s*isOwner && FEATURES\.duplicateScreening &&[\s\S]*Number\.isSafeInteger[\s\S]*:\s*null/);
  assert.match(html,/const existingAd = ads\.find\(ad => ad\.id === id && ad\.owner\)/);
  assert.match(html,/Image match is being reviewed\./);
  assert.doesNotMatch(html,/fingerprint|visual_hash|sha256/i);
});

test('browser still does not invoke the duplicate scanner', () => {
  assert.doesNotMatch(html,/functions\.invoke\(\s*["']scan-ad-duplicate["']/);
});

test('frontend merges public-safe ads with owner-safe private ads', () => {
  assert.match(html,/if \(FEATURES\.duplicateScreening\)[\s\S]*"get_public_ads_with_ai"[\s\S]*"get_public_ads"/);
  assert.match(html,/currentUser[\s\S]*"get_my_ads_with_ai"[\s\S]*"get_my_ads"/);
  assert.match(html,/ownerAdData\.forEach\(ad => adRowsById\.set\(ad\.id, ad\)\)/);
  assert.match(html,/else \{[\s\S]*\.from\("ads"\)[\s\S]*\.select\("\*"\)/);
  assert.match(html,/ad\.moderationStatus !== "approved" \? "disabled"/);
  assert.match(html,/recordedTopup/);
  assert.match(html,/showWalletReturnMessage/);
});

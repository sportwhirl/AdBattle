import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const loadAdsSource = html.slice(
  html.indexOf("async function loadAds()"),
  html.indexOf("/* ========================================\n   START"),
);

test("production browser pins the Supabase client dependency", () => {
  assert.match(
    html,
    /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.117\.1"><\/script>/,
  );
});

function productionLoader(currentUser) {
  const calls = [];
  const adRows = [{
    id: 7,
    user_id: "user-1",
    title: "Existing production ad",
    caption: "Still visible",
    image_url: "https://example.test/ad.png",
    support_total: 12,
    moderation_status: "approved",
    moderation_reason: null,
    created_at: "2026-09-20T00:00:00Z",
  }];
  const db = {
    rpc: async (name) => {
      calls.push(["rpc", name]);
      if (name === "get_seed_counts") {
        return { data: [{ ad_id: 7, seed_count: 2 }], error: null };
      }
      if (name === "get_my_seeded_ad_ids") {
        return { data: currentUser ? [{ ad_id: 7 }] : [], error: null };
      }
      throw new Error(`production called unavailable RPC ${name}`);
    },
    from: (name) => {
      calls.push(["from", name]);
      if (name === "creator_profiles") {
        throw new Error("production queried unavailable creator_profiles");
      }
      if (name === "ads") {
        return {
          select() { return this; },
          async order() { return { data: adRows, error: null }; },
        };
      }
      if (name === "supports") {
        return {
          select() { return this; },
          async eq() { return { data: [], error: null }; },
        };
      }
      throw new Error(`unexpected table ${name}`);
    },
  };
  const context = vm.createContext({
    FEATURES: { seeds: true, duplicateScreening: false },
    currentUser,
    ads: [],
    db,
    console: { error() {} },
    reconcileRecordedSeedPending() {},
  });
  vm.runInContext(`${loadAdsSource}\n;globalThis.run = async () => { await loadAds(); return ads; };`, context);
  return { context, calls };
}

test("production loads existing ads without duplicate-screening schema objects", async () => {
  const { context, calls } = productionLoader({ id: "user-1" });
  const ads = await context.run();

  assert.deepEqual(calls.filter(([kind]) => kind === "from").map(([, name]) => name), [
    "ads",
    "supports",
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === "rpc").map(([, name]) => name), [
    "get_seed_counts",
    "get_my_seeded_ad_ids",
  ]);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].title, "Existing production ad");
  assert.equal(ads[0].owner, true);
  assert.equal(ads[0].seedCount, 2);
  assert.equal(ads[0].seeded, true);
  assert.equal(ads[0].duplicateStatus, null);
  assert.equal(ads[0].duplicateOfAdId, null);
});

test("production posting omits duplicate-only columns and copy", () => {
  assert.match(html, /if \(FEATURES\.duplicateScreening\) \{\s*adInsert\.image_storage_path = fileName;\s*\}/);
  assert.match(html, /\.from\("ads"\)\s*\.insert\(adInsert\)/);
  assert.match(html, /FEATURES\.duplicateScreening\s*\? "Ad submitted\.[\s\S]*duplicate screening[\s\S]*:\s*"Ad submitted\. It is locked and will become public after the safety scan approves it\."/);
  assert.match(html, /if \(!FEATURES\.duplicateScreening\) \{\s*document\.getElementById\("creatorIdentity"\)\.hidden = true;/);
  assert.match(html, /if \(!currentUser \|\| !FEATURES\.duplicateScreening\) return;/);
});

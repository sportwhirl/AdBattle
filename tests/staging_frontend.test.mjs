import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const configJs = readFileSync(new URL("../frontend-config.js", import.meta.url), "utf8");
const httpTs = readFileSync(new URL("../supabase/functions/_shared/http.ts", import.meta.url), "utf8");
const checkoutTs = readFileSync(new URL("../supabase/functions/create-wallet-checkout/index.ts", import.meta.url), "utf8");
const amountParser = vm.createContext({});
vm.runInContext(html.slice(
  html.indexOf("function inputDollarsToCents("),
  html.indexOf("async function functionErrorMessage("),
), amountParser);
const supportPicker = vm.createContext({});
vm.runInContext(`${html.slice(
  html.indexOf("const SUPPORT_FIBONACCI_CENTS"),
  html.indexOf("function pendingSupportKey()"),
)}
globalThis.values = [...SUPPORT_FIBONACCI_CENTS];
globalThis.customIndex = SUPPORT_CUSTOM_INDEX;
globalThis.customMinimum = CUSTOM_SUPPORT_MINIMUM_CENTS;`, supportPicker);

const postAdSource = html.slice(
  html.indexOf("async function postAd()"),
  html.indexOf("/* ========================================\n   POST PAGE"),
);

async function runOrdinaryPost(privateMediaPipeline, insertError = null) {
  const calls = { storageBuckets: [], alerts: [] };
  const elements = {
    newTitle: { value: "Test ad" },
    newCaption: { value: "Test caption" },
    newImage: {
      files: [{ name: "test.png", type: "image/png", size: 128 }],
      value: "selected",
    },
  };
  const context = vm.createContext({
    FEATURES: { adImages: true, privateMediaPipeline },
    currentUser: { id: "creator-1" },
    aiDraftUiEpoch: 0,
    aiDraftUiIsCurrent: (userId, epoch) => userId === "creator-1" && epoch === 0,
    generatedDraftFile: null,
    generatedDraftRequestId: null,
    document: { getElementById: (id) => elements[id] },
    crypto: { randomUUID: () => "image-1" },
    defaultPromotionAllocation: () => ({ youtube: 20 }),
    alert: (message) => calls.alerts.push(message),
    showLogin() {},
    discardAiDraft() { calls.discardAiDraft = true; },
    async loadAds() {},
    showProfile() {},
    profileSection() {},
    console: { error() {} },
    db: {
      storage: {
        from(bucket) {
          calls.storageBuckets.push(bucket);
          return {
            async upload(path) {
              calls.upload = { bucket, path };
              return { error: null };
            },
            getPublicUrl(path) {
              calls.publicUrl = { bucket, path };
              return { data: { publicUrl: `https://cdn.example/${path}` } };
            },
            async remove(paths) {
              calls.remove = { bucket, paths };
              return { error: null };
            },
          };
        },
      },
      from(table) {
        assert.equal(table, "ads");
        return {
          async insert(row) {
            calls.insert = row;
            return { error: insertError };
          },
        };
      },
      functions: { invoke: async () => { throw new Error("unexpected AI submission"); } },
    },
  });
  vm.runInContext(`${postAdSource}\nglobalThis.runPostAd = postAd;`, context);
  await context.runPostAd();
  return calls;
}

const loadAdsSource = html.slice(
  html.indexOf("async function loadAds()"),
  html.indexOf("/* ========================================\n   START", html.indexOf("async function loadAds()")),
);

async function runAdRead(features) {
  const calls = { rpc: [], tables: [], functions: [] };
  const publicRows = [{
    id: 1, user_id: "creator-2", title: "Public", caption: "Visible",
    image_url: "https://cdn.example/public.jpg", support_total: 0,
    created_at: "2026-09-24T00:00:00Z", moderation_status: "approved",
    ai_generated: true,
  }];
  const ownerRows = [{
    id: 2, user_id: "creator-1", title: "Pending", caption: "Private",
    image_url: "", support_total: 0, created_at: "2026-09-24T01:00:00Z",
    moderation_status: "pending_scan", duplicate_status: "pending",
    ai_generated: false,
  }];
  const context = vm.createContext({
    FEATURES: { seeds: false, ...features },
    currentUser: { id: "creator-1" },
    aiDraftUiEpoch: 0,
    adsLoadId: 0,
    aiDraftUiIsCurrent: (userId, epoch) => userId === "creator-1" && epoch === 0,
    ads: [],
    reconcileRecordedSeedPending() {},
    console: { error() {} },
    db: {
      async rpc(name) {
        calls.rpc.push(name);
        if (name.startsWith("get_public_ads")) return { data: publicRows, error: null };
        if (name.startsWith("get_my_ads")) return { data: ownerRows, error: null };
        throw new Error(`Unexpected RPC: ${name}`);
      },
      functions: {
        async invoke(name) {
          calls.functions.push(name);
          return { data: { previews: { 2: "https://private.example/pending" } }, error: null };
        },
      },
      from(table) {
        calls.tables.push(table);
        if (table === "ads") {
          return {
            select(columns) {
              calls.adsSelect = columns;
              return this;
            },
            async order() {
              return { data: publicRows, error: null };
            },
          };
        }
        if (table === "creator_profiles") {
          return {
            select() { return this; },
            async in() {
              return { data: [{ user_id: "creator-2", handle: "public_creator" }], error: null };
            },
          };
        }
        if (table === "supports") {
          return {
            select() { return this; },
            async eq() { return { data: [], error: null }; },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    },
  });
  vm.runInContext(`${loadAdsSource}\nglobalThis.runLoadAds = loadAds;`, context);
  await context.runLoadAds();
  return { calls, ads: JSON.parse(JSON.stringify(context.ads)) };
}

test("wallet amount parsing accepts cents with or without a leading zero", () => {
  for (const [value, cents] of [
    [".01", 1], ["0.01", 1], [" .01 ", 1],
    [".1", 10], ["0.10", 10], [".99", 99],
    ["0", 0], ["0.00", 0], [".00", 0],
    ["1", 100], ["10.", 1000], ["10.00", 1000],
  ]) {
    assert.equal(amountParser.inputDollarsToCents(value), cents, value);
  }
});

test("wallet amount parsing rejects malformed amounts and fractional cents", () => {
  for (const value of [
    "", " ", ".", ".001", "0.001", "1.001", "-.01", "-1", "+.01",
    "1e-2", "0,01", "$0.01", "1.2.3", "NaN", "Infinity",
    "9007199254740992", null, undefined,
  ]) {
    assert.equal(amountParser.inputDollarsToCents(value), null, String(value));
  }
});

function configContext() {
  const context = vm.createContext({ atob, console });
  context.globalThis = context;
  vm.runInContext(configJs, context);
  return context;
}

test("local frontend fails closed unless explicit adbattle-test config is exact", () => {
  const { AdBattleConfig } = configContext();
  const location = { protocol: "http:", hostname: "localhost", origin: "http://localhost:8000" };
  assert.throws(() => AdBattleConfig.resolve(location, null), /refusing to connect/);
  assert.throws(() => AdBattleConfig.resolve(location, {
    environment: "staging", projectRef: "wrong",
    supabaseUrl: "https://bmsrdzqprxvldltaislp.supabase.co",
    frontendOrigin: "http://localhost:8000", publishableKey: "sb_publishable_wrong",
  }), /refusing to connect/);
  const config = AdBattleConfig.resolve(location, {
    environment: "staging", projectRef: "nccqnrcdygujulrnwair",
    supabaseUrl: "https://nccqnrcdygujulrnwair.supabase.co",
    frontendOrigin: "http://localhost:8000", publishableKey: "sb_publishable_test_fixture",
  });
  assert.equal(config.environment, "staging");
  assert.equal(config.projectRef, "nccqnrcdygujulrnwair");
  assert.deepEqual({ ...config.features }, {
    seeds: true,
    adImages: true,
    creatorOnboarding: false,
    duplicateScreening: true,
    aiImageDrafts: false,
    aiProvenanceReads: true,
    privateMediaPipeline: true,
  });
  assert.throws(() => AdBattleConfig.resolve(
    { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8000" },
    {
      environment: "staging", projectRef: "nccqnrcdygujulrnwair",
      supabaseUrl: "https://nccqnrcdygujulrnwair.supabase.co",
      frontendOrigin: "http://localhost:8000", publishableKey: "sb_publishable_test_fixture",
    },
  ), /origin is not allowed/);
  for (const origin of [
    "http://localhost:9000", "http://[::1]:8000", "null", "https://preview.example",
  ]) {
    assert.throws(() => AdBattleConfig.resolve({ origin }, null), /origin is not allowed/);
  }
});

test("hosted frontend preserves production configuration", () => {
  const { AdBattleConfig } = configContext();
  const config = AdBattleConfig.resolve({
    protocol: "https:", hostname: "adbattle.io", origin: "https://adbattle.io",
  }, { environment: "staging" });
  assert.equal(config.environment, "production");
  assert.equal(config.projectRef, "bmsrdzqprxvldltaislp");
  assert.equal(config.features.seeds, true);
  assert.equal(config.features.duplicateScreening, false);
  assert.equal(config.features.aiImageDrafts, false);
  assert.equal(config.features.aiProvenanceReads, false);
  assert.equal(config.features.privateMediaPipeline, false);
  assert.throws(() => AdBattleConfig.resolve({
    protocol: "https:", hostname: "evil.example", origin: "https://evil.example",
  }, null), /origin is not allowed/);
});

test("local staging server requires every explicit project setting", () => {
  const command = ["-c", [
    "import importlib.util",
    "s=importlib.util.spec_from_file_location('serve','scripts/serve_staging.py')",
    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
    "print(m.staging_config()['projectRef'])",
  ].join(";")];
  const baseEnv = { ...process.env,
    ADBATTLE_SUPABASE_PROJECT_REF: "",
    ADBATTLE_SUPABASE_URL: "",
    ADBATTLE_FRONTEND_ORIGIN: "",
    ADBATTLE_SUPABASE_PUBLISHABLE_KEY: "",
  };
  const missing = spawnSync("python3", command, { encoding: "utf8", env: baseEnv });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /refusing to start/);
  const configured = spawnSync("python3", command, { encoding: "utf8", env: {
    ...baseEnv,
    ADBATTLE_SUPABASE_PROJECT_REF: "nccqnrcdygujulrnwair",
    ADBATTLE_SUPABASE_URL: "https://nccqnrcdygujulrnwair.supabase.co",
    ADBATTLE_FRONTEND_ORIGIN: "http://localhost:8000",
    ADBATTLE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture",
  } });
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(configured.stdout.trim(), "nccqnrcdygujulrnwair");
  const serverSource = readFileSync(new URL("../scripts/serve_staging.py", import.meta.url), "utf8");
  assert.match(serverSource, /SUPABASE_URL \+ "\/auth\/v1\/settings"/);
  const redirectCheck = spawnSync("python3", ["-c", [
    "import importlib.util",
    "s=importlib.util.spec_from_file_location('serve','scripts/serve_staging.py')",
    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
    "assert m.NoRedirects().redirect_request(None,None,302,'',{},'https://evil.example') is None",
  ].join(";")], { encoding: "utf8" });
  assert.equal(redirectCheck.status, 0, redirectCheck.stderr);
});

function httpHelpers(env = {}) {
  const js = stripTypeScriptTypes(httpTs).replaceAll("export ", "");
  const context = vm.createContext({
    Deno: { env: { get: (key) => env[key] } }, Request, Response, URL, console,
  });
  vm.runInContext(js, context);
  return context;
}

test("CORS only adds validated production or exact local staging origins", () => {
  let helpers = httpHelpers();
  assert.equal(helpers.corsHeaders(new Request("https://fn.test", {
    headers: { origin: "https://adbattle.io" },
  }))["Access-Control-Allow-Origin"], "https://adbattle.io");
  assert.equal(helpers.corsHeaders(new Request("https://fn.test", {
    headers: { origin: "https://evil.example" },
  }))["Access-Control-Allow-Origin"], undefined);
  assert.throws(() => httpHelpers({ ADBATTLE_STAGING_ORIGIN: "*" }).allowedOrigins(), /must be exactly/);
  assert.throws(() => httpHelpers({
    ADBATTLE_STAGING_ORIGIN: "http://localhost:8000",
  }).checkoutReturnOrigin(), /is required/);
  assert.throws(() => httpHelpers({
    ADBATTLE_STAGING_ORIGIN: "http://localhost:8000",
    ADBATTLE_CHECKOUT_ORIGIN: "https://adbattle.io",
  }).checkoutReturnOrigin(), /must match/);
  helpers = httpHelpers({
    ADBATTLE_STAGING_ORIGIN: "http://localhost:8000",
    ADBATTLE_CHECKOUT_ORIGIN: "http://localhost:8000",
  });
  assert.equal(helpers.checkoutReturnOrigin(), "http://localhost:8000");
  assert.equal(helpers.corsHeaders(new Request("https://fn.test", {
    headers: { origin: "http://localhost:8000" },
  }))["Access-Control-Allow-Origin"], "http://localhost:8000");
});

test("Checkout redirects come only from validated server configuration", () => {
  assert.match(checkoutTs, /checkoutReturnOrigin\(\)/);
  assert.match(checkoutTs, /`\$\{returnOrigin\}\/\?wallet=success/);
  assert.match(checkoutTs, /`\$\{returnOrigin\}\/\?wallet=cancel/);
  assert.doesNotMatch(checkoutTs, /body\?\.(success|cancel|redirect)/);
  assert.match(checkoutTs, /startsWith\("sk_test_"\)/);
});

test("staging enables paid Seeds and image posting while unavailable integrations stay gated", () => {
  assert.match(html, /if \(FEATURES\.seeds\)[\s\S]*?db\.rpc\("get_seed_counts"\)/);
  assert.match(html, /db\.rpc\("get_my_seeded_ad_ids"\)/);
  assert.doesNotMatch(html, /\.from\("likes"\)/);
  assert.match(html, /if \(!FEATURES\.adImages\)[\s\S]*?Ad posting is unavailable/);
  assert.match(html, /if \(!FEATURES\.creatorOnboarding\)[\s\S]*?Creator onboarding is unavailable/);
  assert.match(html, /ADBATTLE TEST · LOCAL STAGING/);
  const { AdBattleConfig } = configContext();
  const staging = AdBattleConfig.resolve(
    { origin: "http://localhost:8000" },
    {
      environment: "staging",
      projectRef: "nccqnrcdygujulrnwair",
      supabaseUrl: "https://nccqnrcdygujulrnwair.supabase.co",
      frontendOrigin: "http://localhost:8000",
      publishableKey: "sb_publishable_test_fixture",
    },
  );
  assert.equal(staging.features.seeds, true);
  assert.equal(staging.features.adImages, true);
  assert.equal(staging.features.duplicateScreening, true);
  assert.equal(staging.features.aiImageDrafts, false);
  assert.equal(staging.features.aiProvenanceReads, true);
  assert.equal(staging.features.privateMediaPipeline, true);
});

test("AI provenance reads remain independent of the AI creation kill switch", () => {
  assert.match(html,
    /FEATURES\.aiProvenanceReads[\s\S]*?"get_public_ads_with_ai"[\s\S]*?: "get_public_ads"/);
  assert.match(html,
    /FEATURES\.aiProvenanceReads[\s\S]*?"get_my_ads_with_ai"[\s\S]*?: "get_my_ads"/);
  assert.doesNotMatch(html,
    /db\.rpc\(FEATURES\.aiImageDrafts \? "get_(?:public|my)_ads_with_ai"/);
});

test("private media is staged locally while production retains its public upload path", () => {
  assert.match(html,
    /FEATURES\.privateMediaPipeline[\s\S]*?\? "ad-pending-images"[\s\S]*?: "ad-images"/);
  assert.match(html,
    /if \(privateMediaPipeline\)[\s\S]*?adInsert\.image_storage_path = fileName/);
  assert.match(html,
    /else \{[\s\S]*?\.from\("ad-images"\)[\s\S]*?\.getPublicUrl\(fileName\)/);
  assert.match(html,
    /const pendingIds = FEATURES\.privateMediaPipeline[\s\S]*?: \[\]/);
});

test("ordinary upload execution never sends production media to the staging bucket", async () => {
  const production = await runOrdinaryPost(false);
  assert.equal(production.upload.bucket, "ad-images");
  assert.equal(production.storageBuckets.includes("ad-pending-images"), false);
  assert.equal(production.insert.image_url,
    "https://cdn.example/creator-1/image-1.png");
  assert.equal("image_storage_path" in production.insert, false);
  assert.equal(production.discardAiDraft, undefined,
    "manual posting must preserve an unrelated AI retry record");

  const staging = await runOrdinaryPost(true);
  assert.equal(staging.upload.bucket, "ad-pending-images");
  assert.equal(staging.storageBuckets.includes("ad-images"), false);
  assert.equal(staging.insert.image_url, "");
  assert.equal(staging.insert.image_storage_path, "creator-1/image-1.png");
});

test("production reads ads through the existing RLS table path only", async () => {
  const { calls, ads } = await runAdRead({
    duplicateScreening: false,
    aiProvenanceReads: false,
    privateMediaPipeline: false,
  });
  assert.equal(calls.adsSelect, "*");
  assert.deepEqual(calls.rpc, []);
  assert.equal(calls.tables.includes("creator_profiles"), false);
  assert.deepEqual(calls.functions, []);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].title, "Public");
});

test("staging uses reviewed provenance RPCs, owner merge, profiles and private previews", async () => {
  const { calls, ads } = await runAdRead({
    duplicateScreening: true,
    aiProvenanceReads: true,
    privateMediaPipeline: true,
  });
  assert.deepEqual(calls.rpc, ["get_public_ads_with_ai", "get_my_ads_with_ai"]);
  assert.equal(calls.tables.includes("ads"), false);
  assert.equal(calls.tables.includes("creator_profiles"), true);
  assert.deepEqual(calls.functions, ["pending-ad-previews"]);
  assert.deepEqual(ads.map(ad => ad.id), [2, 1]);
  assert.equal(ads[0].image, "https://private.example/pending");
  assert.equal(ads[1].creatorHandle, "public_creator");
  assert.equal(ads[1].aiGenerated, true);
});

test("an old owner-ad response cannot populate the next account gallery", async () => {
  let resolvePublicAds;
  const publicAds = new Promise(resolve => { resolvePublicAds = resolve; });
  const calls = [];
  const context = vm.createContext({
    FEATURES: {
      seeds: false,
      duplicateScreening: true,
      aiProvenanceReads: true,
      privateMediaPipeline: true,
    },
    currentUser: { id: "creator-a" },
    aiDraftUiEpoch: 0,
    adsLoadId: 0,
    ads: [{ id: "creator-b-existing-view" }],
    reconcileRecordedSeedPending() {},
    console: { error() {} },
    db: {
      rpc(name) {
        calls.push(name);
        assert.equal(name, "get_public_ads_with_ai");
        return publicAds;
      },
      functions: { invoke() { throw new Error("stale load must stop before previews"); } },
      from() { throw new Error("stale load must stop before table reads"); },
    },
  });
  context.aiDraftUiIsCurrent = (userId, epoch) =>
    context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
  vm.runInContext(`${loadAdsSource}\nglobalThis.runLoadAds = loadAds;`, context);

  const staleLoad = context.runLoadAds();
  context.currentUser = { id: "creator-b" };
  context.aiDraftUiEpoch += 1;
  resolvePublicAds({ data: [{
    id: 9,
    user_id: "creator-a",
    image_url: "https://private.example/creator-a",
  }], error: null });
  await staleLoad;

  assert.deepEqual(calls, ["get_public_ads_with_ai"]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ads)), [
    { id: "creator-b-existing-view" },
  ]);
});

test("an older same-account ad load cannot overwrite a newer snapshot", async () => {
  const pendingReads = [];
  const context = vm.createContext({
    FEATURES: {
      seeds: false,
      duplicateScreening: false,
      aiProvenanceReads: false,
      privateMediaPipeline: false,
    },
    currentUser: { id: "creator-1" },
    aiDraftUiEpoch: 0,
    adsLoadId: 0,
    ads: [],
    reconcileRecordedSeedPending() {},
    console: { error() {} },
    db: {
      from(table) {
        if (table === "ads") {
          return {
            select() { return this; },
            order() {
              return new Promise(resolve => pendingReads.push(resolve));
            },
          };
        }
        if (table === "supports") {
          return {
            select() { return this; },
            async eq() { return { data: [], error: null }; },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    },
  });
  context.aiDraftUiIsCurrent = (userId, epoch) =>
    context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
  vm.runInContext(`${loadAdsSource}\nglobalThis.runLoadAds = loadAds;`, context);

  const older = context.runLoadAds();
  const newer = context.runLoadAds();
  pendingReads[1]({ data: [{
    id: 2, user_id: "creator-2", title: "New snapshot", caption: "new",
    image_url: "https://cdn.example/new.jpg", support_total: 0,
    moderation_status: "approved",
  }], error: null });
  await newer;
  pendingReads[0]({ data: [{
    id: 1, user_id: "creator-2", title: "Old snapshot", caption: "old",
    image_url: "https://cdn.example/old.jpg", support_total: 0,
    moderation_status: "approved",
  }], error: null });
  await older;

  assert.deepEqual(JSON.parse(JSON.stringify(context.ads.map(ad => ad.title))), [
    "New snapshot",
  ]);
});

test("production keeps the reviewed SDK pin and hides unsupported creator controls", () => {
  assert.match(html, /@supabase\/supabase-js@2\.117\.1/);
  assert.doesNotMatch(html, /@supabase\/supabase-js@2["<]/);
  assert.match(html, /id="creatorIdentity"/);
  assert.match(html, /if \(!FEATURES\.duplicateScreening\)[\s\S]*?creatorIdentity/);
  assert.match(html, /if \(!currentUser \|\| !FEATURES\.duplicateScreening\) return/);
});

test("failed private insert accurately says the retained upload needs reconciliation", async () => {
  const result = await runOrdinaryPost(true, { message: "insert unavailable" });
  assert.match(result.alerts.at(-1), /remains private and is retained for reconciliation/);
  assert.equal(result.remove, undefined);
});

test("uncertain production insert retains the public upload for reconciliation", async () => {
  const result = await runOrdinaryPost(false, { message: "insert unavailable" });
  assert.equal(result.remove, undefined);
  assert.match(result.alerts.at(-1), /retained for reconciliation/);
  assert.match(result.alerts.at(-1), /Do not resubmit/);
  assert.equal(result.storageBuckets.includes("ad-pending-images"), false);
});

test("Support slider maps exact Fibonacci cents and reserves its final stop for Custom $50+", () => {
  assert.deepEqual([...supportPicker.values], [
    1, 2, 3, 5, 8, 13, 21, 34, 55,
    89, 144, 233, 377, 610, 987,
    1597, 2584, 4181,
  ]);
  assert.equal(supportPicker.customIndex, 18);
  assert.equal(supportPicker.customMinimum, 5000);
  assert.equal(supportPicker.supportPresetCents(0), 1);
  assert.equal(supportPicker.supportPresetCents(17), 4181);
  assert.equal(supportPicker.supportPresetCents(18), null);
  assert.equal(supportPicker.supportPresetIndex(4181), 17);
  assert.equal(supportPicker.supportPresetIndex(5000), 18);
  assert.equal(amountParser.inputDollarsToCents("49.99") < supportPicker.customMinimum, true);
  assert.equal(amountParser.inputDollarsToCents("50.00"), supportPicker.customMinimum);
});

test("paid Seed and custom Support rules are disclosed in the rendered controls", () => {
  assert.match(html, /Seed · 1¢/);
  assert.match(html, /once per ad and can’t be undone/);
  assert.match(html, /final stop opens Custom \$50\+/);
  assert.match(html, /Custom Support must be at least \$50\.00/);
  assert.match(html, /aria-valuetext="\$0\.01"/);
  assert.match(html, /setAttribute\("role", "group"\)/);
});

const topupHelper = html.slice(
  html.indexOf("function pendingTopupKey()"),
  html.indexOf("/* ========================================\n   AUTH"),
);

function topupClient(storage, invoke, from = () => { throw new Error("not used"); }) {
  const context = vm.createContext({
    currentUser: { id: "user-1" }, PROJECT_REF: "project-1", localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    crypto: globalThis.crypto, URL, console: { error() {}, log() {} },
    walletTopupAmount: { value: "10.00", focus() {} },
    walletTopupButton: { disabled: false, innerText: "Add Funds" },
    walletMessage: { innerText: "" },
    window: { location: { href: "" } },
    db: { functions: { invoke }, from },
    inputDollarsToCents: amountParser.inputDollarsToCents,
    formatCents: (cents) => `$${(cents / 100).toFixed(2)}`,
    functionErrorMessage: async (error, data, fallback) => data?.error || error?.message || fallback,
    showLogin() {},
    aiDraftUiEpoch: 0,
  });
  context.aiDraftUiIsCurrent = (userId, epoch) =>
    context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
  vm.runInContext(topupHelper, context);
  return context;
}

test("accepting leading decimals preserves the ten-dollar top-up minimum", async () => {
  const requests = [];
  const invoke = async (name, { body }) => {
    requests.push({ name, amountCents: body.amount_cents });
    return { data: { url: "https://checkout.stripe.com/c/pay/cs_test_MINIMUM123" } };
  };
  for (const value of [".01", "0.01", ".99", "9.99"]) {
    const storage = new Map();
    const context = topupClient(storage, invoke);
    context.walletTopupAmount.value = value;
    await context.addWalletFunds();
    assert.equal(context.walletMessage.innerText, "The minimum account top-up is $10.00.");
    assert.equal(storage.size, 0);
    assert.equal(requests.length, 0);
  }
  const context = topupClient(new Map(), invoke);
  context.walletTopupAmount.value = "10.00";
  await context.addWalletFunds();
  assert.deepEqual(requests, [{ name: "create-wallet-checkout", amountCents: 1000 }]);
});

test("top-up retries reuse project/user-scoped request identity after a lost response", async () => {
  const storage = new Map();
  const requestIds = [];
  let calls = 0;
  const invoke = async (_name, { body }) => {
    calls++;
    requestIds.push(body.request_id);
    if (calls === 1) return { error: new Error("uncertain response") };
    return { data: { url: "https://checkout.stripe.com/c/pay/cs_test_RETRY123" } };
  };
  await topupClient(storage, invoke).addWalletFunds();
  assert.equal(storage.size, 1);
  assert.match([...storage.keys()][0], /^adbattle:pending-topup:project-1:user-1$/);
  await topupClient(storage, invoke).addWalletFunds();
  assert.equal(requestIds[0], requestIds[1]);
  assert.equal(JSON.parse([...storage.values()][0]).checkout_session_id, "cs_test_RETRY123");
});

test("pending top-up blocks a changed amount and storage failure prevents Checkout", async () => {
  const storage = new Map();
  let calls = 0;
  const invoke = async () => { calls++; return { error: new Error("offline") }; };
  const first = topupClient(storage, invoke);
  await first.addWalletFunds();
  const changed = topupClient(storage, invoke);
  changed.walletTopupAmount.value = "20.00";
  await changed.addWalletFunds();
  assert.match(changed.walletMessage.innerText, /Resolve your pending/);
  assert.equal(calls, 1);

  const unavailable = topupClient(new Map(), invoke);
  unavailable.localStorage.setItem = () => { throw new Error("storage unavailable"); };
  await unavailable.addWalletFunds();
  assert.equal(calls, 1);
});

test("pending top-up is removed only after its exact paid session is visible", async () => {
  const key = "adbattle:pending-topup:project-1:user-1";
  const pending = {
    amount_cents: 1000, request_id: "request-1", checkout_session_id: "cs_test_EXACT",
  };
  const storage = new Map([[key, JSON.stringify(pending)]]);
  const from = () => {
    let filters = 0;
    return {
      select() { return this; },
      eq() {
        filters++;
        return filters === 2
          ? Promise.resolve({ data: [{ amount_cents: 1000, status: "paid" }] })
          : this;
      },
    };
  };
  assert.equal(await topupClient(storage, async () => {}, from).reconcilePendingTopup(), true);
  assert.equal(storage.size, 0);

  storage.set(key, JSON.stringify(pending));
  const mismatch = () => {
    let filters = 0;
    return {
      select() { return this; },
      eq() {
        filters++;
        return filters === 2
          ? Promise.resolve({ data: [{ amount_cents: 2000, status: "paid" }] })
          : this;
      },
    };
  };
  assert.equal(await topupClient(storage, async () => {}, mismatch).reconcilePendingTopup(), false);
  assert.equal(storage.size, 1);
});

test("stale or unknown-age top-up state is retained and never retried", async () => {
  const key = "adbattle:pending-topup:project-1:user-1";
  for (const pending of [
    { amount_cents: 1000, request_id: "unknown-age" },
    { amount_cents: 1000, request_id: "stale", created_at_ms: Date.now() - 20 * 60 * 60 * 1000 },
  ]) {
    const storage = new Map([[key, JSON.stringify(pending)]]);
    let calls = 0;
    const client = topupClient(storage, async () => { calls++; return {}; });
    await client.addWalletFunds();
    assert.match(client.walletMessage.innerText, /reconcile/);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(storage.get(key)).request_id, pending.request_id);
  }
});

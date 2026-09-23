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
    likes: false, adImages: true, creatorOnboarding: false,
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
  assert.equal(config.features.likes, true);
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

test("staging enables image posting while unavailable integrations remain gated", () => {
  assert.match(html, /if \(FEATURES\.likes\)[\s\S]*?\.from\("likes"\)/);
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
  assert.equal(staging.features.adImages, true);
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
  });
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

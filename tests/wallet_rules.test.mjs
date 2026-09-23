import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const migrationSql = readFileSync(
  new URL("../supabase/migrations/20260920_wallet_ledger.sql", import.meta.url),
  "utf8",
);
const supportFunctionTs = readFileSync(
  new URL("../supabase/functions/support-from-wallet/index.ts", import.meta.url),
  "utf8",
);

function splitSupport(amountCents) {
  const grossMicros = amountCents * 10_000;
  const creatorMicros = grossMicros * 90 / 100;
  return {
    grossMicros,
    creatorMicros,
    platformMicros: grossMicros - creatorMicros,
  };
}

function nextThresholdCents(lifetimeCents) {
  if (lifetimeCents < 1_000) return 1_000;
  if (lifetimeCents < 2_500) return 2_500;
  if (lifetimeCents < 5_000) return 5_000;
  if (lifetimeCents < 10_000) return 10_000;

  let threshold = 20_000;
  while (threshold <= lifetimeCents) threshold *= 2;
  return threshold;
}

function isSettlementDue({
  lifetimeCents,
  nextThreshold,
  pendingGrossMicros,
  lastSupportAgeHours,
}) {
  return lifetimeCents >= nextThreshold ||
    (pendingGrossMicros >= 10_000_000 && lastSupportAgeHours >= 24);
}

function transferableCreatorBalance(pendingCreatorMicros) {
  const transferCents = Math.floor(pendingCreatorMicros / 10_000);
  return {
    transferCents,
    rolloverMicros: pendingCreatorMicros - transferCents * 10_000,
  };
}

test("one-cent Support preserves the exact 90/10 split", () => {
  assert.deepEqual(splitSupport(1), {
    grossMicros: 10_000,
    creatorMicros: 9_000,
    platformMicros: 1_000,
  });
});

test("many micro-supports aggregate to whole-cent creator transfers", () => {
  const oneCent = splitSupport(1);
  assert.equal(oneCent.creatorMicros * 1_000 / 10_000, 900);
  assert.equal(oneCent.platformMicros * 1_000 / 10_000, 100);
});

test("fractional creator cents roll forward instead of being discarded", () => {
  assert.deepEqual(transferableCreatorBalance(9_000), {
    transferCents: 0,
    rolloverMicros: 9_000,
  });

  assert.deepEqual(transferableCreatorBalance(18_000), {
    transferCents: 1,
    rolloverMicros: 8_000,
  });

  assert.deepEqual(transferableCreatorBalance(9_000_000), {
    transferCents: 900,
    rolloverMicros: 0,
  });
});

test("threshold ladder is $10, $25, $50, $100, then doubles", () => {
  assert.equal(nextThresholdCents(0), 1_000);
  assert.equal(nextThresholdCents(999), 1_000);
  assert.equal(nextThresholdCents(1_000), 2_500);
  assert.equal(nextThresholdCents(2_500), 5_000);
  assert.equal(nextThresholdCents(5_000), 10_000);
  assert.equal(nextThresholdCents(10_000), 20_000);
  assert.equal(nextThresholdCents(20_000), 40_000);
  assert.equal(nextThresholdCents(80_000), 160_000);
});

test("threshold settlement does not wait for inactivity", () => {
  assert.equal(isSettlementDue({
    lifetimeCents: 1_000,
    nextThreshold: 1_000,
    pendingGrossMicros: 10_000_000,
    lastSupportAgeHours: 0,
  }), true);
});

test("inactivity settlement requires $10 pending and 24 hours", () => {
  assert.equal(isSettlementDue({
    lifetimeCents: 4_300,
    nextThreshold: 5_000,
    pendingGrossMicros: 18_000_000,
    lastSupportAgeHours: 24,
  }), true);

  assert.equal(isSettlementDue({
    lifetimeCents: 4_300,
    nextThreshold: 5_000,
    pendingGrossMicros: 9_990_000,
    lastSupportAgeHours: 48,
  }), false);

  assert.equal(isSettlementDue({
    lifetimeCents: 4_300,
    nextThreshold: 5_000,
    pendingGrossMicros: 18_000_000,
    lastSupportAgeHours: 23.99,
  }), false);
});

test("frontend is wired to the wallet flow, not direct Support Checkout", () => {
  assert.match(indexHtml, /"create-wallet-checkout"/);
  assert.match(indexHtml, /"support-from-wallet"/);
  assert.doesNotMatch(indexHtml, /invoke\(\s*"create-checkout-session"/);
});

test("database enforces one-cent Support and explicit 90\/10 accrual", () => {
  assert.match(migrationSql, /if p_amount_cents < 1 then/);
  assert.match(migrationSql, /creator_micros := gross_micros \* 90 \/ 100/);
  assert.match(migrationSql, /platform_micros := gross_micros - creator_micros/);
});

async function callSupportEdge(body, rpcError = null) {
  let handler;
  const rpcCalls = [];
  let clientNumber = 0;
  const source = stripTypeScriptTypes(
    supportFunctionTs.replace(/import[\s\S]*?from "[^"]+";\n/g, ""),
  );
  const context = vm.createContext({
    Deno: {
      env: { get: () => "configured" },
      serve: (callback) => { handler = callback; },
    },
    createClient: () => {
      clientNumber++;
      if (clientNumber === 1) {
        return {
          auth: {
            getUser: async () => ({
              data: { user: { id: "authenticated-user" } },
              error: null,
            }),
          },
        };
      }
      return {
        rpc: async (name, args) => {
          rpcCalls.push({ name, args });
          return rpcError
            ? { data: null, error: rpcError }
            : { data: { recorded: true, balance_cents: 99 }, error: null };
        },
      };
    },
    corsPreflightResponse: () => ({ status: 204 }),
    errorMessage: (error) => error?.message || "error",
    isUuid: (value) => /^[0-9a-f-]{36}$/.test(value),
    jsonResponse: (_request, responseBody, status = 200) => ({
      body: responseBody,
      status,
    }),
    parseBearerToken: () => "jwt",
    requestOriginAllowed: () => true,
    console: { error() {} },
  });
  vm.runInContext(source, context);
  const response = await handler({
    method: "POST",
    json: async () => body,
  });
  return { response, rpcCalls };
}

test("wallet Edge function routes Seed and Support through purpose-aware RPCs", async () => {
  const requestId = "10000000-0000-4000-8000-000000000001";
  const seed = await callSupportEdge({
    action: "seed",
    ad_id: 7,
    amount_cents: 1,
    request_id: requestId,
    user_id: "attacker-controlled",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(seed.rpcCalls)), [{
    name: "seed_ad_from_wallet",
    args: {
      p_user_id: "authenticated-user",
      p_ad_id: 7,
      p_request_id: requestId,
    },
  }]);
  assert.equal(seed.response.body.action, "seed");

  const support = await callSupportEdge({
    ad_id: 8,
    amount_cents: 55,
    request_id: requestId,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(support.rpcCalls)), [{
    name: "support_ad_from_wallet",
    args: {
      p_user_id: "authenticated-user",
      p_ad_id: 8,
      p_amount_cents: 55,
      p_request_id: requestId,
    },
  }]);
  assert.equal(support.response.body.action, "support");
});

test("wallet Edge function rejects coercion, invalid action, and non-cent Seed before RPC", async () => {
  const requestId = "10000000-0000-4000-8000-000000000001";
  for (const body of [
    { action: "gift", ad_id: 1, amount_cents: 1, request_id: requestId },
    { action: "seed", ad_id: 1, amount_cents: 2, request_id: requestId },
    { action: "seed", ad_id: "1", amount_cents: 1, request_id: requestId },
    { action: "seed", ad_id: 1, amount_cents: "1", request_id: requestId },
    { action: "support", ad_id: Number.MAX_SAFE_INTEGER + 1, amount_cents: 1, request_id: requestId },
  ]) {
    const result = await callSupportEdge(body);
    assert.equal(result.response.status, 400);
    assert.equal(result.rpcCalls.length, 0);
  }
});

test("wallet Edge function maps cross-purpose replay and own-ad Seed safely", async () => {
  const body = {
    action: "seed",
    ad_id: 1,
    amount_cents: 1,
    request_id: "10000000-0000-4000-8000-000000000001",
  };
  assert.equal(
    (await callSupportEdge(body, { message: "REQUEST_ID_CONFLICT" })).response.status,
    409,
  );
  const own = await callSupportEdge(body, { message: "SEED_OWN_AD" });
  assert.equal(own.response.status, 400);
  assert.match(own.response.body.error, /own ad/);
});

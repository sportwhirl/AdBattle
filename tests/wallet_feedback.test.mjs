import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const walletCode = html.slice(html.indexOf("async function loadWalletBalance()"),
  html.indexOf("/* ========================================\n   AUTH"));
const startCode = html.slice(html.indexOf("async function startApp()"), html.lastIndexOf("startApp();"));
const key = "adbattle:pending-topup:project-1:user-1";
const pending = { amount_cents: 1000, request_id: "request-1", checkout_session_id: "cs_test_EXACT" };
const paid = { user_id: "user-1", stripe_session_id: "cs_test_EXACT", amount_cents: 1000, status: "paid" };

function client({ status = "disputed", search = "?wallet=success", walletStatus = "frozen" } = {}) {
  const storage = new Map([[key, JSON.stringify(pending)]]);
  const state = { rows: [{ ...paid, status }], queryError: null, beforeTopupRead: null };
  const notices = [];
  const timers = [];
  const context = vm.createContext({
    currentUser: { id: "user-1" }, PROJECT_REF: "project-1", URLSearchParams, URL,
    aiDraftUiEpoch: 0,
    walletLoadId: 0,
    creatorBalanceLoadId: 0,
    window: { location: { search } }, console: { error() {}, log() {} },
    walletBalance: { innerText: "" }, walletMessage: { innerText: "" }, walletBalanceCents: 0,
    creatorBalanceStatus: { innerText: "" }, formatCents: (cents) => `$${(cents / 100).toFixed(2)}`,
    formatMicros: () => "$0.00", checkUser: async () => {}, loadAds: async () => {},
    showProfile() {}, showSupported() {},
    showReturnMessage: (message, success = false) => notices.push({ message, success }),
    setTimeout: (callback) => timers.push(callback),
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    db: {
      functions: { invoke() { throw new Error("feedback must not initiate a payment"); } },
      from(table) {
        const filters = [];
        return {
          select() { return this; },
          eq(column, value) { filters.push([column, value]); return this; },
          maybeSingle() { return Promise.resolve({ data: { available_cents: 1800, status: walletStatus } }); },
          async then(resolve, reject) {
            try {
              if (table === "ad_settlement_state") return resolve({ data: [] });
              assert.equal(table, "wallet_topups");
              assert.deepEqual(filters, [["user_id", "user-1"], ["stripe_session_id", "cs_test_EXACT"]]);
              await state.beforeTopupRead?.();
              return resolve({ data: state.rows.filter((row) => filters.every(([k, v]) => row[k] === v)), error: state.queryError });
            } catch (error) { return reject(error); }
          },
        };
      },
    },
  });
  vm.runInContext(
    "function aiDraftUiIsCurrent(userId, epoch) { return currentUser?.id === userId && aiDraftUiEpoch === epoch; }\n"
      + walletCode + "\n" + startCode,
    context,
  );
  return { context, storage, state, notices, timers };
}

test("credited dispute return shows the recorded payment and review hold instead of verification", async () => {
  const c = client();
  await c.context.startApp();
  assert.equal(c.storage.size, 0);
  assert.equal(c.context.walletBalance.innerText, "$18.00");
  assert.match(c.context.walletMessage.innerText, /payment review/);
  assert.match(c.notices.at(-1).message, /\$10\.00 top-up was recorded/);
  assert.match(c.notices.at(-1).message, /on hold for payment review/);
  assert.equal(c.notices.at(-1).success, false);
  for (const callback of c.timers) await callback();
  assert.match(c.notices.at(-1).message, /top-up was recorded/);
  assert.doesNotMatch(c.notices.at(-1).message, /verifying|completed|available to spend/i);
});

test("all recorded top-up lifecycle statuses reconcile their exact session", async () => {
  for (const status of ["paid", "partially_refunded", "refunded", "disputed"]) {
    const c = client({ status });
    assert.equal(await c.context.reconcilePendingTopup(), true, status);
    assert.equal(c.storage.size, 0, status);
  }
});

test("unverified or mismatched top-ups retain the exact pending request", async () => {
  for (const rows of [
    [], [{ ...paid, status: "pending" }], [{ ...paid, amount_cents: 2000 }],
    [{ ...paid, stripe_session_id: "cs_test_OTHER" }], [{ ...paid, user_id: "user-2" }],
    [paid, paid],
  ]) {
    const c = client();
    c.state.rows = rows;
    await c.context.startApp();
    assert.equal(c.storage.get(key), JSON.stringify(pending));
    assert.match(c.notices.at(-1).message, /not been verified/);
    assert.doesNotMatch(c.notices.at(-1).message, /was recorded|completed/);
  }
});

test("query failure preserves retry state and wallet loading still reports the hold", async () => {
  const c = client();
  c.state.queryError = { message: "offline" };
  await c.context.startApp();
  assert.equal(c.storage.get(key), JSON.stringify(pending));
  assert.equal(c.context.walletBalance.innerText, "$18.00");
  assert.match(c.notices.at(-1).message, /not been verified/);
  assert.match(c.context.walletMessage.innerText, /payment review/);
});

test("a delayed reconciliation cannot delete a replacement pending request", async () => {
  const c = client();
  const replacement = JSON.stringify({ ...pending, request_id: "request-2" });
  c.state.beforeTopupRead = () => c.storage.set(key, replacement);
  assert.equal(await c.context.reconcilePendingTopup(), false);
  assert.equal(c.storage.get(key), replacement);
});

test("an auth change during reconciliation neither clears state nor renders the old balance", async () => {
  const c = client();
  c.state.beforeTopupRead = () => { c.context.currentUser = { id: "user-2" }; };
  await c.context.loadWalletBalance();
  assert.equal(c.storage.get(key), JSON.stringify(pending));
  assert.equal(c.context.walletBalance.innerText, "");
  assert.equal(c.notices.length, 0);
});

test("cancel URLs preserve unverified requests but accept authoritative recorded credits", async () => {
  const c = client({ search: "?wallet=cancel" });
  c.state.rows = [];
  await c.context.startApp();
  assert.equal(c.storage.get(key), JSON.stringify(pending));
  assert.match(c.notices.at(-1).message, /not been verified/);
  assert.doesNotMatch(c.notices.at(-1).message, /not charged/i);
  c.state.rows = [{ ...paid, status: "refunded" }];
  await c.context.loadWalletBalance();
  assert.equal(c.storage.size, 0);
  assert.match(c.notices.at(-1).message, /was recorded/);
});

test("a success URL alone cannot claim payment completion or match an arbitrary top-up", async () => {
  const c = client({ status: "paid", walletStatus: "active" });
  c.storage.clear();
  await c.context.startApp();
  assert.match(c.notices.at(-1).message, /Checkout returned/);
  assert.doesNotMatch(c.notices.at(-1).message, /completed|top-up was recorded|verifying/i);
  assert.equal(c.notices.at(-1).success, false);
});

test("paid confirmation remains confirmed on refresh without changing wallet balances", async () => {
  const c = client({ status: "paid", walletStatus: "active" });
  await c.context.startApp();
  assert.equal(c.notices.at(-1).success, true);
  for (const callback of c.timers) await callback();
  assert.match(c.notices.at(-1).message, /top-up was recorded/);
  assert.equal(c.context.walletBalance.innerText, "$18.00");
});

test("missing login and unavailable local storage cannot claim a confirmed payment", async () => {
  const loggedOut = client();
  loggedOut.context.currentUser = null;
  await loggedOut.context.startApp();
  assert.match(loggedOut.notices.at(-1).message, /Log in/);
  assert.equal(loggedOut.storage.size, 1);

  const blocked = client();
  blocked.context.localStorage.getItem = () => { throw new Error("storage blocked"); };
  await blocked.context.startApp();
  assert.equal(blocked.context.walletBalance.innerText, "$18.00");
  assert.match(blocked.notices.at(-1).message, /could not be verified/i);
  assert.equal(blocked.storage.size, 1);
});

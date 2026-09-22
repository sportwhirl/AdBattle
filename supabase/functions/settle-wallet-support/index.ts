import { createClient } from "npm:@supabase/supabase-js@2";

type Settlement = {
  settlement_id: string;
  ad_id: number;
  creator_user_id: string;
  stripe_account_id: string;
  creator_transfer_cents: number;
  creator_micros: number;
  platform_micros: number;
  trigger_reason: "threshold" | "inactivity";
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
const settlementSecret = Deno.env.get("SETTLEMENT_CRON_SECRET");

if (!supabaseUrl || !serviceRoleKey || !stripeSecret || !settlementSecret) {
  throw new Error("Settlement worker environment variables are missing.");
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function retrySettlement(settlementId: string, error: string) {
  const { error: rpcError } = await admin.rpc("retry_wallet_settlement", {
    p_settlement_id: settlementId,
    p_error: error,
  });

  if (rpcError) {
    console.error("Couldn't schedule settlement retry:", rpcError);
  }
}

async function sendStripeTransfer(settlement: Settlement, destination: string, idempotencyKey: string) {
  const params = new URLSearchParams();
  params.set("amount", String(settlement.creator_transfer_cents));
  params.set("currency", "usd");
  params.set("destination", destination);
  params.set("transfer_group", `adbattle_ad_${settlement.ad_id}`);
  params.set("metadata[settlement_id]", settlement.settlement_id);
  params.set("metadata[ad_id]", String(settlement.ad_id));
  params.set("metadata[creator_user_id]", settlement.creator_user_id);
  params.set("metadata[trigger_reason]", settlement.trigger_reason);

  return await fetch("https://api.stripe.com/v1/transfers", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Same ID and immutable parameters, only inside the bounded retry window.
      "Idempotency-Key": idempotencyKey,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(30_000),
  });
}

async function transferSettlement(settlement: Settlement) {
  // Do not silently enable real-money transfers before production review.
  if (!stripeSecret!.startsWith("sk_test_")) {
    throw new Error("Wallet settlements are restricted to Stripe test mode.");
  }
  const { data: guard, error: guardError } = await admin.rpc("prepare_wallet_transfer", {
    p_settlement_id: settlement.settlement_id,
  });
  if (guardError) throw new Error("Could not authorize this transfer attempt.");
  if (guard?.allowed !== true) return { status: "held", reason: guard?.reason || "not_authorized" };
  if (!guard.destination || Date.now() >= Date.parse(guard.retry_before) - 60_000 ||
      !Number.isFinite(Date.parse(guard.retry_before))) {
    return { status: "held", reason: "retry_window_expired" };
  }
  const stripeResponse = await sendStripeTransfer(settlement, guard.destination,
    guard.idempotency_key || `adbattle-settlement-${settlement.settlement_id}`);

  const transfer = await stripeResponse.json();
  if (!stripeResponse.ok || typeof transfer?.id !== "string") {
    throw new Error(
      transfer?.error?.message || "Stripe did not complete the creator transfer.",
    );
  }

  const { error: completeError } = await admin.rpc(
    "complete_wallet_settlement",
    {
      p_settlement_id: settlement.settlement_id,
      p_stripe_transfer_id: transfer.id,
    },
  );

  if (completeError) {
    // Bounded retries only. A prolonged failure is held for reconciliation;
    // never assume Stripe keeps an idempotency key indefinitely.
    throw new Error(`Transfer created but ledger completion failed: ${completeError.message}`);
  }

  return { status: "succeeded", transfer_id: transfer.id as string };
}

// Explicit operator recovery: verifies the original key with Stripe, then
// persists one replacement BEFORE any normal worker can POST with that key.
async function recoverCapabilityFailure(settlementId: string) {
  if (!stripeSecret!.startsWith("sk_test_")) {
    throw new Error("Wallet settlements are restricted to Stripe test mode.");
  }
  const { data: row, error } = await admin.from("support_settlements")
    .select("id,ad_id,creator_user_id,creator_transfer_cents,trigger_reason,status")
    .eq("id", settlementId).maybeSingle();
  if (error || !row) throw new Error("Could not read recovery settlement.");
  if (row.status !== "retry") {
    return { settlement_id: settlementId, status: "held", reason: "recovery_requires_retry" };
  }
  const { data: account, error: accountError } = await admin.from("creator_accounts")
    .select("stripe_account_id,onboarding_complete,charges_enabled,payouts_enabled")
    .eq("user_id", row.creator_user_id).maybeSingle();
  if (accountError || !account?.stripe_account_id || !account.onboarding_complete ||
      !account.charges_enabled || !account.payouts_enabled) {
    return { settlement_id: settlementId, status: "held", reason: "creator_not_ready" };
  }
  const settlement = { ...row, settlement_id: row.id } as Settlement;
  const { data: guard, error: guardError } = await admin.rpc("prepare_wallet_transfer", {
    p_settlement_id: settlementId,
  });
  if (guardError) throw new Error("Could not authorize recovery verification.");
  if (guard?.allowed !== true || !guard.destination || !Number.isFinite(Date.parse(guard.retry_before)) ||
      Date.now() >= Date.parse(guard.retry_before) - 60_000) {
    return { settlement_id: settlementId, status: "held", reason: guard?.reason || "retry_window_expired" };
  }
  // Readiness for a newly linked account says nothing about the frozen
  // destination. Refuse verification before contacting Stripe in that case.
  if (account.stripe_account_id !== guard.destination) {
    return { settlement_id: settlementId, status: "held", reason: "recovery_destination_mismatch" };
  }
  if (typeof guard.idempotency_key !== "string") {
    throw new Error("Apply the capability recovery migration before using recovery.");
  }
  const originalKey = `adbattle-settlement-${settlementId}`;
  if (guard.idempotency_key !== originalKey) {
    return { settlement_id: settlementId, status: "recovery_already_authorized" };
  }
  const response = await sendStripeTransfer(settlement, guard.destination, originalKey);
  const transfer = await response.json();
  if (response.ok && typeof transfer?.id === "string") {
    // If the original key actually succeeded, reconcile that transfer; never
    // authorize a second key. This also handles a previously lost response.
    const { error: completeError } = await admin.rpc("complete_wallet_settlement", {
      p_settlement_id: settlementId, p_stripe_transfer_id: transfer.id,
    });
    if (completeError) throw new Error("Transfer found but ledger completion failed; keep original key.");
    return { settlement_id: settlementId, status: "succeeded", transfer_id: transfer.id };
  }
  const requestId = response.headers.get("Request-Id");
  const replayed = response.headers.get("Idempotent-Replayed") === "true";
  if (response.status !== 400 || !replayed || typeof transfer?.id === "string" ||
      transfer?.error?.code !== "insufficient_capabilities_for_transfer" ||
      !requestId || !/^req_[A-Za-z0-9]+$/.test(requestId)) {
    return { settlement_id: settlementId, status: "held", reason: "cached_capability_rejection_not_verified",
      stripe_status: response.status, stripe_error_code: transfer?.error?.code || null,
      idempotent_replayed: replayed };
  }
  const { error: recoveryError } = await admin.rpc("authorize_wallet_capability_recovery", {
    p_settlement_id: settlementId, p_failed_key: originalKey,
    p_stripe_request_id: requestId, p_error_code: transfer.error.code,
  });
  if (recoveryError) throw new Error("Recovery was not confirmed; repeat the same recovery request to reconcile.");
  // This request has not sent the replacement key to Stripe. A normal worker
  // run will load the committed key, respecting the existing retry schedule.
  return { settlement_id: settlementId, status: "recovery_authorized" };
}

function recoveryWindowOpen(guard: { retry_before?: string }) {
  const deadline = Date.parse(guard.retry_before || "");
  return Number.isFinite(deadline) && Date.now() < deadline - 60_000;
}

async function availableStripeUsdCardBalance() {
  // Authenticate exactly as transfer creation: platform account, no connected-
  // account header. Pending, reserved and other-currency funds cannot qualify.
  const response = await fetch("https://api.stripe.com/v1/balance", {
    method: "GET", headers: { "Authorization": `Bearer ${stripeSecret}` },
    signal: AbortSignal.timeout(30_000),
  });
  const balance = await response.json();
  const requestId = response.headers.get("Request-Id");
  if (!response.ok || balance?.object !== "balance" || balance.livemode !== false ||
      !Array.isArray(balance.available) || !requestId || !/^req_[A-Za-z0-9]+$/.test(requestId)) {
    throw new Error("Could not verify the platform's test-mode available balance.");
  }
  const usd = balance.available.filter((item: { currency?: string }) => item?.currency === "usd");
  if (usd.length !== 1 || !Number.isSafeInteger(usd[0].amount) ||
      !Number.isSafeInteger(usd[0].source_types?.card)) {
    throw new Error("Could not verify available USD card funds.");
  }
  return { cents: Math.min(usd[0].amount, usd[0].source_types.card), requestId };
}

// A separate, bounded stage for the already-authorized capability key. It never
// rotates an arbitrary key or resets the original 20-hour retry window.
async function recoverBalanceFailure(settlementId: string) {
  if (!stripeSecret!.startsWith("sk_test_")) {
    throw new Error("Wallet settlements are restricted to Stripe test mode.");
  }
  const { data: row, error } = await admin.from("support_settlements")
    .select("id,ad_id,creator_user_id,creator_transfer_cents,trigger_reason,status")
    .eq("id", settlementId).maybeSingle();
  if (error || !row) throw new Error("Could not read recovery settlement.");
  if (row.status !== "retry") {
    return { settlement_id: settlementId, status: "held", reason: "recovery_requires_retry" };
  }
  if (!Number.isSafeInteger(row.creator_transfer_cents) || row.creator_transfer_cents <= 0) {
    throw new Error("Invalid settlement amount.");
  }
  const { data: account, error: accountError } = await admin.from("creator_accounts")
    .select("stripe_account_id,onboarding_complete,charges_enabled,payouts_enabled")
    .eq("user_id", row.creator_user_id).maybeSingle();
  if (accountError || !account?.stripe_account_id || !account.onboarding_complete ||
      !account.charges_enabled || !account.payouts_enabled) {
    return { settlement_id: settlementId, status: "held", reason: "creator_not_ready" };
  }
  const { data: guard, error: guardError } = await admin.rpc("prepare_wallet_transfer", {
    p_settlement_id: settlementId,
  });
  if (guardError) throw new Error("Could not authorize recovery verification.");
  if (guard?.allowed !== true || !guard.destination || !recoveryWindowOpen(guard)) {
    return { settlement_id: settlementId, status: "held", reason: guard?.reason || "retry_window_expired" };
  }
  if (account.stripe_account_id !== guard.destination) {
    return { settlement_id: settlementId, status: "held", reason: "recovery_destination_mismatch" };
  }
  if (guard.balance_recovery_supported !== true) {
    throw new Error("Apply the balance recovery migration before using this action.");
  }
  const failedKey = `adbattle-settlement-${settlementId}-capability-recovery-1`;
  const recoveryKey = `adbattle-settlement-${settlementId}-balance-recovery-1`;
  if (guard.idempotency_key === recoveryKey) {
    return { settlement_id: settlementId, status: "balance_recovery_already_authorized" };
  }
  if (guard.idempotency_key !== failedKey) {
    return { settlement_id: settlementId, status: "held", reason: "requires_capability_recovery_key" };
  }
  const before = await availableStripeUsdCardBalance();
  if (before.cents < row.creator_transfer_cents) {
    return { settlement_id: settlementId, status: "held", reason: "insufficient_available_balance" };
  }
  // The balance GET can be slow. Reload the authoritative guard immediately
  // before POST so newly committed holds, key changes and expiry are observed.
  const { data: refreshedGuard, error: refreshedGuardError } = await admin.rpc("prepare_wallet_transfer", {
    p_settlement_id: settlementId,
  });
  if (refreshedGuardError) throw new Error("Could not refresh recovery authorization.");
  if (refreshedGuard?.allowed !== true || !recoveryWindowOpen(refreshedGuard)) {
    return { settlement_id: settlementId, status: "held", reason: refreshedGuard?.reason || "retry_window_expired" };
  }
  if (refreshedGuard.balance_recovery_supported !== true) {
    throw new Error("Balance recovery authorization is unavailable.");
  }
  if (refreshedGuard.destination !== guard.destination ||
      refreshedGuard.destination !== account.stripe_account_id) {
    return { settlement_id: settlementId, status: "held", reason: "recovery_destination_mismatch" };
  }
  if (refreshedGuard.idempotency_key === recoveryKey) {
    return { settlement_id: settlementId, status: "balance_recovery_already_authorized" };
  }
  if (refreshedGuard.idempotency_key !== failedKey) {
    return { settlement_id: settlementId, status: "held", reason: "requires_capability_recovery_key" };
  }
  const settlement = { ...row, settlement_id: row.id } as Settlement;
  const response = await sendStripeTransfer(settlement, refreshedGuard.destination, failedKey);
  const transfer = await response.json();
  if (response.ok && typeof transfer?.id === "string") {
    if (transfer.object !== "transfer" || transfer.amount !== row.creator_transfer_cents ||
        transfer.currency !== "usd" || transfer.destination !== refreshedGuard.destination ||
        transfer.metadata?.settlement_id !== settlementId) {
      return { settlement_id: settlementId, status: "held", reason: "transfer_details_mismatch" };
    }
    const { error: completeError } = await admin.rpc("complete_wallet_settlement", {
      p_settlement_id: settlementId, p_stripe_transfer_id: transfer.id,
    });
    if (completeError) throw new Error("Transfer found but ledger completion failed; keep the existing key.");
    return { settlement_id: settlementId, status: "succeeded", transfer_id: transfer.id };
  }
  const requestId = response.headers.get("Request-Id");
  if (response.status !== 400 || response.headers.get("Idempotent-Replayed") !== "true" ||
      transfer?.id != null || transfer?.error?.type !== "invalid_request_error" ||
      transfer?.error?.code !== "balance_insufficient" ||
      !requestId || !/^req_[A-Za-z0-9]+$/.test(requestId)) {
    return { settlement_id: settlementId, status: "held", reason: "cached_balance_rejection_not_verified" };
  }
  // Obtain fresh balance evidence after verification, before committing a key.
  const after = await availableStripeUsdCardBalance();
  if (after.cents < row.creator_transfer_cents || !recoveryWindowOpen(refreshedGuard)) {
    return { settlement_id: settlementId, status: "held", reason: "balance_or_retry_window_changed" };
  }
  const { error: recoveryError } = await admin.rpc("authorize_wallet_balance_recovery", {
    p_settlement_id: settlementId, p_failed_key: failedKey,
    p_stripe_request_id: requestId, p_error_code: transfer.error.code,
    p_available_cents: after.cents, p_balance_request_id: after.requestId,
  });
  if (recoveryError) throw new Error("Recovery was not confirmed; repeat the same recovery request to reconcile.");
  // No POST with the new key in this invocation. Normal worker retries load it
  // from the committed guard, even after response loss or ledger failure.
  return { settlement_id: settlementId, status: "balance_recovery_authorized" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (req.headers.get("x-adbattle-settlement-secret") !== settlementSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
  } catch {
    return Response.json({ error: "Expected an empty body or a recovery JSON object." }, { status: 400 });
  }
  if (Object.keys(body).length) {
    const action = Object.keys(body)[0];
    const settlementId = body[action];
    if (Object.keys(body).length !== 1 ||
        !["recover_capability_failure", "recover_balance_failure"].includes(action) ||
        typeof settlementId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settlementId)) {
      return Response.json({ error: "Invalid recovery request." }, { status: 400 });
    }
    try {
      const recover = action === "recover_balance_failure" ? recoverBalanceFailure : recoverCapabilityFailure;
      return Response.json({ recovery: await recover(settlementId.toLowerCase()) });
    } catch {
      return Response.json({ error: "Recovery could not be confirmed. Inspect settlement state; keep its identity and retry history." }, { status: 500 });
    }
  }

  const { data, error } = await admin.rpc("claim_due_wallet_settlements", {
    p_limit: 25,
  });

  if (error) {
    console.error("Settlement claim failed:", error);
    return Response.json({ error: "Couldn't claim settlements." }, { status: 500 });
  }

  const settlements = (data || []) as Settlement[];
  const results: Array<Record<string, unknown>> = [];

  for (const settlement of settlements) {
    try {
      const outcome = await transferSettlement(settlement);
      results.push({
        settlement_id: settlement.settlement_id,
        ...outcome,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transfer error";
      console.error("Settlement transfer failed:", settlement.settlement_id, error);

      // The preparation RPC refuses future POSTs once the retry window expires.
      await retrySettlement(settlement.settlement_id, message);
      results.push({
        settlement_id: settlement.settlement_id,
        status: "retry",
        error: message,
      });
    }
  }

  return Response.json({ processed: settlements.length, results });
});

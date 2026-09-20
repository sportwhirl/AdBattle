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

async function transferSettlement(settlement: Settlement) {
  // Do not silently enable real-money transfers before production review.
  if (!stripeSecret!.startsWith("sk_test_")) {
    throw new Error("Wallet settlements are restricted to Stripe test mode.");
  }
  const { data: guard, error: guardError } = await admin.rpc("prepare_wallet_transfer", {
    p_settlement_id: settlement.settlement_id,
  });
  if (guardError) throw new Error("Could not authorize this transfer attempt.");
  if (!guard?.allowed) return { status: "held", reason: guard?.reason || "not_authorized" };
  if (!guard.destination || Date.now() >= Date.parse(guard.retry_before) - 60_000 ||
      !Number.isFinite(Date.parse(guard.retry_before))) {
    return { status: "held", reason: "retry_window_expired" };
  }
  const params = new URLSearchParams();
  params.set("amount", String(settlement.creator_transfer_cents));
  params.set("currency", "usd");
  params.set("destination", guard.destination);
  params.set("transfer_group", `adbattle_ad_${settlement.ad_id}`);
  params.set("metadata[settlement_id]", settlement.settlement_id);
  params.set("metadata[ad_id]", String(settlement.ad_id));
  params.set("metadata[creator_user_id]", settlement.creator_user_id);
  params.set("metadata[trigger_reason]", settlement.trigger_reason);

  const stripeResponse = await fetch("https://api.stripe.com/v1/transfers", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Same ID and immutable parameters, only inside the bounded retry window.
      "Idempotency-Key": `adbattle-settlement-${settlement.settlement_id}`,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(30_000),
  });

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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (req.headers.get("x-adbattle-settlement-secret") !== settlementSecret) {
    return new Response("Unauthorized", { status: 401 });
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

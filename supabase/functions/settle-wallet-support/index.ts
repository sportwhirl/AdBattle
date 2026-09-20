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
  const params = new URLSearchParams();
  params.set("amount", String(settlement.creator_transfer_cents));
  params.set("currency", "usd");
  params.set("destination", settlement.stripe_account_id);
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
      // Reusing the settlement ID makes a retry safe even if Stripe completed
      // the transfer but the first HTTP response was lost.
      "Idempotency-Key": `adbattle-settlement-${settlement.settlement_id}`,
    },
    body: params.toString(),
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
    // Leave this settlement in processing. The database reclaims stale
    // processing work with the same ID and Stripe idempotency key.
    throw new Error(`Transfer created but ledger completion failed: ${completeError.message}`);
  }

  return transfer.id as string;
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
      const transferId = await transferSettlement(settlement);
      results.push({
        settlement_id: settlement.settlement_id,
        status: "succeeded",
        transfer_id: transferId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transfer error";
      console.error("Settlement transfer failed:", settlement.settlement_id, error);

      // If ledger completion failed after Stripe accepted the transfer, this
      // retry still remains safe because the same settlement ID is reused.
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


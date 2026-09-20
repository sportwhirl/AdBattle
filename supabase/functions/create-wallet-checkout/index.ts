import { createClient } from "npm:@supabase/supabase-js@2";
import {
  corsHeaders,
  errorMessage,
  isUuid,
  jsonResponse,
  parseBearerToken,
} from "../_shared/http.ts";

const MINIMUM_TOPUP_CENTS = 1000;
const MAXIMUM_TOPUP_CENTS = 1_000_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");

    if (!supabaseUrl || !anonKey || !stripeSecret) {
      throw new Error("Wallet Checkout is not configured.");
    }

    const token = parseBearerToken(req);
    if (!token) {
      return jsonResponse(req, { error: "You must be logged in." }, 401);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: userError } =
      await authClient.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse(req, { error: "Your login session is invalid." }, 401);
    }

    const body = await req.json();
    const amountCents = Number(body?.amount_cents);
    const requestId = body?.request_id;

    if (!Number.isInteger(amountCents) || amountCents < MINIMUM_TOPUP_CENTS) {
      return jsonResponse(
        req,
        { error: "The minimum account top-up is $10.00." },
        400,
      );
    }

    if (amountCents > MAXIMUM_TOPUP_CENTS) {
      return jsonResponse(
        req,
        { error: "The maximum account top-up is $10,000.00." },
        400,
      );
    }

    if (!isUuid(requestId)) {
      return jsonResponse(req, { error: "Invalid top-up request." }, 400);
    }

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set(
      "success_url",
      "https://adbattle.io/?wallet=success&session_id={CHECKOUT_SESSION_ID}",
    );
    params.set("cancel_url", "https://adbattle.io/?wallet=cancel");
    params.set("client_reference_id", user.id);
    params.set("line_items[0][price_data][currency]", "usd");
    params.set(
      "line_items[0][price_data][product_data][name]",
      "AdBattle account balance",
    );
    params.set(
      "line_items[0][price_data][product_data][description]",
      "Funds for supporting ads on AdBattle",
    );
    params.set(
      "line_items[0][price_data][unit_amount]",
      String(amountCents),
    );
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[payment_type]", "wallet_topup");
    params.set("metadata[wallet_user_id]", user.id);
    params.set("metadata[amount_cents]", String(amountCents));
    params.set("metadata[request_id]", requestId);
    params.set(
      "payment_intent_data[metadata][payment_type]",
      "wallet_topup",
    );
    params.set("payment_intent_data[metadata][wallet_user_id]", user.id);
    params.set(
      "payment_intent_data[metadata][amount_cents]",
      String(amountCents),
    );
    params.set("payment_intent_data[metadata][request_id]", requestId);

    if (user.email) {
      params.set("customer_email", user.email);
    }

    // No transfer_data is supplied. Stripe charges the AdBattle platform.
    // Creator transfers happen later from the internal 90/10 ledger.
    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeSecret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `adbattle-wallet-${user.id}-${requestId}`,
        },
        body: params.toString(),
      },
    );

    const session = await stripeResponse.json();
    if (!stripeResponse.ok) {
      throw new Error(
        session?.error?.message || "Couldn't create the top-up payment page.",
      );
    }

    if (typeof session?.url !== "string") {
      throw new Error("Stripe did not return a Checkout URL.");
    }

    return jsonResponse(req, { url: session.url });
  } catch (error) {
    console.error("create-wallet-checkout error:", error);
    return jsonResponse(req, { error: errorMessage(error) }, 500);
  }
});


import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import {
  corsPreflightResponse,
  errorMessage,
  isUuid,
  jsonResponse,
  parseBearerToken,
  requestOriginAllowed,
} from "../_shared/http.ts";

function publicSupportError(
  message: string,
  action: "seed" | "support",
) {
  if (message.includes("WALLET_NOT_FUNDED")) {
    return [
      action === "seed"
        ? "Add funds to your account before Seeding an ad."
        : "Add funds to your account before supporting an ad.",
      400,
    ] as const;
  }
  if (message.includes("WALLET_FROZEN")) {
    return ["This balance is temporarily unavailable.", 403] as const;
  }
  if (message.includes("INSUFFICIENT_WALLET_BALANCE")) {
    return [
      action === "seed"
        ? "You need at least 1¢ in your AdBattle balance to Seed this ad."
        : "Your AdBattle balance is too low for that Support.",
      400,
    ] as const;
  }
  if (message.includes("AD_NOT_FOUND")) {
    return ["That ad no longer exists.", 404] as const;
  }
  if (message.includes("AD_NOT_APPROVED")) {
    return [
      action === "seed"
        ? "This ad is not currently approved for Seeding."
        : "This ad is not currently approved for Support.",
      400,
    ] as const;
  }
  if (message.includes("SUPPORT_BELOW_MINIMUM")) {
    return ["The minimum Support is $0.01.", 400] as const;
  }
  if (message.includes("SEED_OWN_AD")) {
    return ["You can't Seed your own ad.", 400] as const;
  }
  if (message.includes("INVALID_SEED_REQUEST")) {
    return ["Invalid Seed request.", 400] as const;
  }
  if (message.includes("REQUEST_ID_CONFLICT")) {
    return ["This saved wallet action does not match the requested Seed or Support. Retry the original action.", 409] as const;
  }

  return [
    action === "seed"
      ? "Couldn't record this Seed."
      : "Couldn't record this Support.",
    500,
  ] as const;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed." }, 405);
  }
  if (!requestOriginAllowed(req)) {
    return jsonResponse(req, { error: "Origin is not allowed." }, 403);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Wallet Support is not configured.");
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
    const adId = body?.ad_id;
    const amountCents = body?.amount_cents;
    const requestId = body?.request_id;
    const action = body?.action ?? "support";

    if (!["support", "seed"].includes(action)) {
      return jsonResponse(req, { error: "Invalid Support action." }, 400);
    }

    if (!Number.isSafeInteger(adId) || adId <= 0) {
      return jsonResponse(req, { error: "Invalid ad." }, 400);
    }

    if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
      return jsonResponse(req, { error: "The minimum Support is $0.01." }, 400);
    }

    if (action === "seed" && amountCents !== 1) {
      return jsonResponse(req, { error: "A Seed is exactly $0.01." }, 400);
    }

    if (!isUuid(requestId)) {
      return jsonResponse(req, { error: "Invalid Support request." }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const rpcName = action === "seed"
      ? "seed_ad_from_wallet"
      : "support_ad_from_wallet";
    const rpcArguments = action === "seed"
      ? {
        p_user_id: user.id,
        p_ad_id: adId,
        p_request_id: requestId,
      }
      : {
        p_user_id: user.id,
        p_ad_id: adId,
        p_amount_cents: amountCents,
        p_request_id: requestId,
      };

    const { data, error } = await admin.rpc(rpcName, rpcArguments);

    if (error) {
      console.error(`${rpcName} error:`, error);
      const [message, status] = publicSupportError(
        error.message || "",
        action,
      );
      return jsonResponse(req, { error: message }, status);
    }

    return jsonResponse(req, {
      ok: true,
      action,
      ...data,
    });
  } catch (error) {
    console.error("support-from-wallet error:", error);
    return jsonResponse(req, { error: errorMessage(error) }, 500);
  }
});

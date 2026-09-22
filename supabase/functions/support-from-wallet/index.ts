import { createClient } from "npm:@supabase/supabase-js@2";
import {
  corsPreflightResponse,
  errorMessage,
  isUuid,
  jsonResponse,
  parseBearerToken,
  requestOriginAllowed,
} from "../_shared/http.ts";

function publicSupportError(message: string) {
  if (message.includes("WALLET_NOT_FUNDED")) {
    return ["Add at least $10.00 to your account before supporting an ad.", 400] as const;
  }
  if (message.includes("WALLET_FROZEN")) {
    return ["This balance is temporarily unavailable.", 403] as const;
  }
  if (message.includes("INSUFFICIENT_WALLET_BALANCE")) {
    return ["Your AdBattle balance is too low for that Support.", 400] as const;
  }
  if (message.includes("AD_NOT_FOUND")) {
    return ["That ad no longer exists.", 404] as const;
  }
  if (message.includes("AD_NOT_APPROVED")) {
    return ["This ad is not currently approved for Support.", 400] as const;
  }
  if (message.includes("SUPPORT_BELOW_MINIMUM")) {
    return ["The minimum Support is $0.01.", 400] as const;
  }

  return ["Couldn't record this Support.", 500] as const;
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
    const adId = Number(body?.ad_id);
    const amountCents = Number(body?.amount_cents);
    const requestId = body?.request_id;

    if (!Number.isInteger(adId) || adId <= 0) {
      return jsonResponse(req, { error: "Invalid ad." }, 400);
    }

    if (!Number.isInteger(amountCents) || amountCents < 1) {
      return jsonResponse(req, { error: "The minimum Support is $0.01." }, 400);
    }

    if (!isUuid(requestId)) {
      return jsonResponse(req, { error: "Invalid Support request." }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await admin.rpc("spend_wallet_support", {
      p_user_id: user.id,
      p_ad_id: adId,
      p_amount_cents: amountCents,
      p_request_id: requestId,
    });

    if (error) {
      console.error("spend_wallet_support error:", error);
      const [message, status] = publicSupportError(error.message || "");
      return jsonResponse(req, { error: message }, status);
    }

    return jsonResponse(req, {
      ok: true,
      ...data,
    });
  } catch (error) {
    console.error("support-from-wallet error:", error);
    return jsonResponse(req, { error: errorMessage(error) }, 500);
  }
});

const PRODUCTION_ORIGINS = [
  "https://adbattle.io",
  "https://www.adbattle.io",
  "https://sportwhirl.github.io",
];

const LOCAL_STAGING_ORIGIN = "http://localhost:8000";

function stagingOrigin() {
  const configured = Deno.env.get("ADBATTLE_STAGING_ORIGIN")?.trim();
  if (!configured) return null;
  if (configured !== LOCAL_STAGING_ORIGIN) {
    throw new Error(
      `ADBATTLE_STAGING_ORIGIN must be exactly ${LOCAL_STAGING_ORIGIN}.`,
    );
  }
  return configured;
}

export function allowedOrigins() {
  const staging = stagingOrigin();
  return staging ? [...PRODUCTION_ORIGINS, staging] : [...PRODUCTION_ORIGINS];
}

export function requestOriginAllowed(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || allowedOrigins().includes(origin);
}

export function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-adbattle-settlement-secret, x-adbattle-backfill-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };

  if (allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function corsPreflightResponse(req: Request) {
  if (!requestOriginAllowed(req) || !req.headers.get("origin")) {
    return jsonResponse(req, { error: "Origin is not allowed." }, 403);
  }
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function checkoutReturnOrigin() {
  const staging = stagingOrigin();
  const supplied = Deno.env.get("ADBATTLE_CHECKOUT_ORIGIN")?.trim();
  if (staging && !supplied) {
    throw new Error(
      "ADBATTLE_CHECKOUT_ORIGIN is required when local staging is enabled.",
    );
  }
  const configured = supplied || "https://adbattle.io";
  if (staging) {
    if (configured === staging) return configured;
    throw new Error(
      "ADBATTLE_CHECKOUT_ORIGIN must match ADBATTLE_STAGING_ORIGIN.",
    );
  }
  if (configured === "https://adbattle.io") return configured;
  throw new Error(
    "ADBATTLE_CHECKOUT_ORIGIN must be https://adbattle.io or the configured local staging origin.",
  );
}

export function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status = 200,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(req),
  });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function parseBearerToken(req: Request) {
  const value = req.headers.get("authorization") || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

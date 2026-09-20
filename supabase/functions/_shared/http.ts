export const allowedOrigins = [
  "https://adbattle.io",
  "https://www.adbattle.io",
  "https://sportwhirl.github.io",
];

export function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";

  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
      ? origin
      : "https://adbattle.io",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-adbattle-settlement-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
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


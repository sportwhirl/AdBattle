import {
  corsPreflightResponse,
  jsonResponse,
  requestOriginAllowed,
} from "../_shared/http.ts";

// This endpoint powered the retired per-Support Stripe Checkout flow.
// Keep the name deployed temporarily so cached clients fail closed instead
// of creating a payment under the obsolete 1/9/90 allocation model.
Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }
  if (!requestOriginAllowed(req)) {
    return jsonResponse(req, { error: "Origin is not allowed." }, 403);
  }

  return jsonResponse(
    req,
    {
      error:
        "Direct Support checkout has moved to the AdBattle balance. Refresh the page, add at least $10.00 to your balance, and try again.",
    },
    410,
  );
});

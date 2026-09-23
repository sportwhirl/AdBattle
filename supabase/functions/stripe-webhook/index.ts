import Stripe from "npm:stripe@22.6.2";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!stripeSecret || !webhookSecret || !supabaseUrl || !serviceRoleKey) {
  throw new Error("Stripe webhook environment variables are missing.");
}

const stripe = new Stripe(stripeSecret);
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function paymentIntentId(session: Stripe.Checkout.Session) {
  if (typeof session.payment_intent === "string") {
    return session.payment_intent;
  }

  return session.payment_intent?.id || null;
}

async function recordWalletTopup(session: Stripe.Checkout.Session) {
  if (session.livemode) throw new Error("Wallet payments are restricted to test mode.");
  if (session.payment_status !== "paid") return;
  if (session.currency !== "usd") {
    throw new Error(`Unexpected top-up currency on ${session.id}`);
  }

  const amountCents = session.amount_total;
  const metadataAmountCents = Number(session.metadata?.amount_cents);
  const userId = session.metadata?.wallet_user_id;

  if (
    !Number.isInteger(amountCents) ||
    !amountCents ||
    amountCents < 1000 ||
    metadataAmountCents !== amountCents ||
    !userId
  ) {
    throw new Error(`Invalid wallet top-up metadata on ${session.id}`);
  }

  // Check the current charge as well as webhook history: a delayed paid
  // event must not make an already-refunded/disputed payment spendable.
  const intentId = paymentIntentId(session);
  if (!intentId) throw new Error("Wallet payment intent is missing.");
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const latestChargeId = typeof intent.latest_charge === "string"
    ? intent.latest_charge : intent.latest_charge?.id;
  if (!latestChargeId) throw new Error("Wallet charge is missing.");
  const currentCharge = await stripe.charges.retrieve(latestChargeId);
  if (currentCharge.amount_refunded > 0 || currentCharge.disputed) {
    await recordPaymentRisk(currentCharge, `checkout-risk:${session.id}`,
      "checkout.risk_snapshot", Boolean(currentCharge.disputed));
  }
  const { data, error } = await admin.rpc("record_wallet_topup", {
    p_stripe_session_id: session.id,
    p_stripe_payment_intent_id: paymentIntentId(session) || "",
    p_user_id: userId,
    p_amount_cents: amountCents,
  });

  if (error) {
    console.error("record_wallet_topup error:", error);
    throw new Error("Couldn't credit the verified wallet top-up.");
  }

  console.log("Wallet top-up processed:", {
    session_id: session.id,
    user_id: userId,
    amount_cents: amountCents,
    credited: data?.credited,
  });
}

async function recordPaymentRisk(
  charge: Stripe.Charge, eventId: string, eventType: string, disputeSeen: boolean,
) {
  const intentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (intent.metadata?.payment_type !== "wallet_topup") return;
  const userId = intent.metadata?.wallet_user_id;
  if (!userId) throw new Error("Wallet risk user is missing.");
  const { error } = await admin.rpc("record_wallet_payment_risk", {
    p_payment_intent_id: intentId,
    p_user_id: userId,
    p_refunded_cents: charge.amount_refunded,
    p_dispute_seen: disputeSeen || Boolean(charge.disputed),
    p_event_id: eventId,
    p_event_type: eventType,
  });
  if (error) throw new Error(`Could not persist wallet payment risk: ${error.message}`);
}

// Kept during the migration so a direct-Support Checkout session created
// before the frontend switch can still be recorded safely.
async function recordLegacyDirectSupport(session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid") return;
  if (session.currency !== "usd") {
    throw new Error(`Unexpected support currency on ${session.id}`);
  }

  const amountCents = session.amount_total;
  const adId = Number(session.metadata?.ad_id);
  const supporterUserId = session.metadata?.supporter_user_id;
  const creatorAmountCents = Number(session.metadata?.creator_amount_cents);
  const publishingAmountCents = Number(session.metadata?.publishing_amount_cents);
  const platformAmountCents = Number(session.metadata?.platform_amount_cents);

  if (
    !Number.isInteger(amountCents) ||
    !amountCents ||
    !Number.isInteger(adId) ||
    adId <= 0 ||
    !supporterUserId ||
    !Number.isInteger(creatorAmountCents) ||
    creatorAmountCents < 0 ||
    !Number.isInteger(publishingAmountCents) ||
    publishingAmountCents < 0 ||
    !Number.isInteger(platformAmountCents) ||
    platformAmountCents < 0 ||
    creatorAmountCents + publishingAmountCents + platformAmountCents !== amountCents
  ) {
    throw new Error(`Invalid legacy Support metadata on ${session.id}`);
  }

  let promotionAllocation: Record<string, number>;
  try {
    promotionAllocation = JSON.parse(
      session.metadata?.promotion_allocation || "{}",
    );
  } catch {
    throw new Error(`Invalid promotion allocation on ${session.id}`);
  }

  const requiredPlatforms = [
    "youtube",
    "instagram",
    "tiktok",
    "snapchat",
    "facebook",
  ];
  const allocationValues = requiredPlatforms.map((platform) =>
    Number(promotionAllocation[platform])
  );
  const allocationTotal = allocationValues.reduce(
    (sum, value) => sum + value,
    0,
  );

  if (
    allocationValues.some((value) =>
      !Number.isFinite(value) || value < 0 || value > 100
    ) || Math.abs(allocationTotal - 100) > 0.001
  ) {
    throw new Error(`Invalid promotion allocation on ${session.id}`);
  }

  const { error } = await admin.rpc("record_verified_support", {
    p_stripe_session_id: session.id,
    p_stripe_payment_intent_id: paymentIntentId(session),
    p_user_id: supporterUserId,
    p_ad_id: adId,
    p_amount: amountCents / 100,
    p_creator_amount: creatorAmountCents / 100,
    p_publishing_amount: publishingAmountCents / 100,
    p_platform_amount: platformAmountCents / 100,
    p_promotion_allocation: promotionAllocation,
  });

  if (error) {
    console.error("record_verified_support error:", error);
    throw new Error("Couldn't record verified legacy Support.");
  }

  // The legacy RPC predates the snapshot percentage and source columns.
  // Apply their truthful values even when the RPC reports a duplicate;
  // this also repairs a retry after a transient post-RPC failure.
  const creatorSharePercent = amountCents > 0
    ? creatorAmountCents * 100 / amountCents
    : 0;
  const { error: snapshotError } = await admin
    .from("supports")
    .update({
      creator_share_percent: creatorSharePercent,
      source: "stripe_direct",
    })
    .eq("stripe_session_id", session.id);

  if (snapshotError) {
    console.error("Legacy Support snapshot update error:", snapshotError);
    throw new Error("Couldn't finalize the legacy Support snapshot.");
  }
}

async function processPaidSession(session: Stripe.Checkout.Session) {
  if (session.metadata?.payment_type === "wallet_topup") {
    await recordWalletTopup(session);
    return;
  }

  if (session.metadata?.ad_id) {
    await recordLegacyDirectSupport(session);
    return;
  }

  console.log("Ignoring unrelated Checkout session:", session.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing Stripe-Signature", { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (error) {
    console.error("Stripe signature verification failed:", error);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await processPaidSession(event.data.object as Stripe.Checkout.Session);
        break;
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        await recordPaymentRisk(charge, event.id, event.type, false);
        break;
      }
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
        const charge = await stripe.charges.retrieve(chargeId);
        // Never auto-unfreeze on won/closed events: reconcile refunds,
        // previously transferred funds, and fees before releasing a hold.
        await recordPaymentRisk(charge, event.id, event.type, true);
        break;
      }
      default:
        console.log("Ignoring Stripe event:", event.type);
    }

    return Response.json({ received: true });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    // Stripe retries non-2xx webhook deliveries.
    return new Response("Webhook processing failed", { status: 500 });
  }
});

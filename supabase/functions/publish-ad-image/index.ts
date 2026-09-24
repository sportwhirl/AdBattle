import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsonResponse } from "../_shared/http.ts";
import { loadOwnedImage } from "../_shared/storage-scan-policy.ts";
import { sha256Hex } from "../_shared/image-fingerprint.ts";

const PRIVATE_BUCKET = "ad-pending-images";
const PUBLIC_BUCKET = "ad-images";
function secretMatches(actual: string | null, expected: string | undefined) {
  // The Dashboard's multiline secret field may retain one copied terminal LF.
  // HTTP header values cannot contain it; preserve every other secret byte.
  const normalizedExpected = expected?.endsWith("\n") ? expected.slice(0, -1) : expected;
  if (!normalizedExpected || normalizedExpected.length < 32 || !actual ||
      actual.length !== normalizedExpected.length) return false;
  let difference = 0;
  for (let i = 0; i < normalizedExpected.length; i++) {
    difference |= actual.charCodeAt(i) ^ normalizedExpected.charCodeAt(i);
  }
  return difference === 0;
}

async function deferFailedJob(admin: ReturnType<typeof createClient>, adId: number) {
  try {
    const { error } = await admin.rpc("defer_ad_image_publication", { p_ad_id: adId });
    if (error) console.error("Publication retry scheduling failed", adId);
  } catch {
    // A failed queue update must not stop the sweep from trying later jobs.
    console.error("Publication retry scheduling failed", adId);
  }
}

async function publishOne(admin: ReturnType<typeof createClient>, adId: number) {
  const { data: before, error: lookupError } = await admin.from("ads")
    .select("id,user_id,image_storage_path,image_publication_state,published_image_sha256,ai_source_request_id,ai_post_sha256")
    .eq("id", adId).single();
  if (lookupError || !before) throw new Error("Ad not found");
  let status: string;
  if (before.image_publication_state === "public") {
    status = "already_public";
  } else {
    const { data: claim, error: claimError } = await admin.rpc("claim_ad_image_publication", { p_ad_id: adId });
    if (claimError || !Array.isArray(claim) || claim.length !== 1) throw new Error("Claim failed");
    const { public_path: publicPath, expected_sha256: expectedSha } = claim[0];
    if (before.ai_source_request_id && before.ai_post_sha256 !== expectedSha) {
      throw new Error("AI canonical image does not match both scans");
    }
    const privateBytes = await loadOwnedImage(
      admin.storage.from(PRIVATE_BUCKET), before.user_id, before.image_storage_path);
    if (await sha256Hex(privateBytes) !== expectedSha) throw new Error("Private image changed after screening");
    const contentType = privateBytes[0] === 0xff ? "image/jpeg" : "image/png";
    const publicBucket = admin.storage.from(PUBLIC_BUCKET);
    const { error: uploadError } = await publicBucket.upload(publicPath, privateBytes, {
      upsert: false, contentType, cacheControl: "31536000",
    });
    if (uploadError && !/already exists|duplicate|409/i.test(uploadError.message || "")) {
      throw new Error("Public upload failed");
    }
    // A retry may see a prior immutable upload. Verify its exact bytes.
    const publicBytes = await loadOwnedImage(publicBucket, before.user_id, publicPath);
    if (await sha256Hex(publicBytes) !== expectedSha) throw new Error("Public image hash mismatch");
    const { data: publicUrl } = publicBucket.getPublicUrl(publicPath);
    if (!publicUrl?.publicUrl) throw new Error("Public URL unavailable");
    const { data: result, error: completeError } = await admin.rpc("complete_ad_image_publication", {
      p_ad_id: adId, p_sha256: expectedSha, p_public_path: publicPath,
      p_public_url: publicUrl.publicUrl,
    });
    if (completeError || !["approved", "already_public"].includes(result)) {
      throw new Error("Publication finalization failed");
    }
    status = result;
  }
  // If this cleanup fails, the queue remains and the next sweep sees an
  // already-public row. Never delete the storage object on uncertain errors.
  const cleanup = await admin.from("ad_image_publication_queue").delete().eq("ad_id", adId);
  if (cleanup.error) console.error("Publication queue cleanup deferred", adId);
  return status;
}

Deno.serve(async (request) => {
  if (request.method !== "POST" || request.headers.has("origin")) {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }
  if (!secretMatches(request.headers.get("x-adbattle-publisher-secret"),
    Deno.env.get("ADBATTLE_IMAGE_PUBLISHER_SECRET"))) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return jsonResponse(request, { error: "SERVER_CONFIGURATION_ERROR" }, 503);
  let body: Record<string, unknown>;
  try {
    if (Number(request.headers.get("content-length")) > 2048) throw new Error();
    body = await request.json();
  } catch { return jsonResponse(request, { error: "INVALID_REQUEST" }, 400); }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  if (body?.action === "sweep") {
    const { data: jobs, error: queueError } = await admin.from("ad_image_publication_queue")
      .select("ad_id").lte("next_attempt_at", new Date().toISOString())
      .order("next_attempt_at").order("created_at").limit(10);
    if (queueError || !jobs) return jsonResponse(request, { error: "QUEUE_UNAVAILABLE" }, 503);
    let completed = 0;
    let deferred = 0;
    for (const job of jobs) {
      try { await publishOne(admin, job.ad_id); completed++; }
      catch (error) {
        deferred++;
        await deferFailedJob(admin, job.ad_id);
        console.error("Image publication deferred", job.ad_id, error);
      }
    }
    return jsonResponse(request, { completed, deferred }, deferred ? 503 : 200);
  }
  const adId = Number(body?.ad_id ?? (body?.record as Record<string, unknown>)?.ad_id);
  if (!Number.isSafeInteger(adId) || adId <= 0) {
    return jsonResponse(request, { error: "INVALID_AD_ID" }, 400);
  }
  try {
    return jsonResponse(request, { status: await publishOne(admin, adId) }, 200);
  } catch (error) {
    // The row remains unpublished; never delete an object on an uncertain
    // failure, since another worker may have just finalized that same path.
    console.error("Image publication deferred", adId, error);
    await deferFailedJob(admin, adId);
    return jsonResponse(request, { error: "PUBLICATION_INCOMPLETE", status: "pending" }, 503);
  }
});

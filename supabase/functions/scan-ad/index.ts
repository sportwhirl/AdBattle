import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { decode } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { corsPreflightResponse, jsonResponse, requestOriginAllowed } from "../_shared/http.ts";
import { differenceHash, sha256Hex, VISUAL_HASH_VERSION } from "../_shared/image-fingerprint.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (!requestOriginAllowed(request)) return jsonResponse(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method !== "POST") return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return jsonResponse(request, { error: "SERVER_CONFIGURATION_ERROR" }, 500);

  const authorization = request.headers.get("authorization") || "";
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);

  let adId: number;
  try {
    adId = Number((await request.json()).ad_id);
    if (!Number.isSafeInteger(adId) || adId <= 0) throw new Error();
  } catch {
    return jsonResponse(request, { error: "INVALID_AD_ID" }, 400);
  }

  const admin = createClient(url, serviceKey);
  const { data: indexState, error: indexError } = await admin.from("ad_image_index_state")
    .select("ready").eq("singleton", true).single();
  if (indexError || !indexState?.ready) {
    return jsonResponse(request, { error: "INDEX_BACKFILL_INCOMPLETE", status: "pending" }, 503);
  }
  const { data: ad, error: adError } = await admin.from("ads")
    .select("id,user_id,image_storage_path,duplicate_status").eq("id", adId).single();
  if (adError || !ad || ad.user_id !== user.id) return jsonResponse(request, { error: "AD_NOT_FOUND" }, 404);
  if (ad.duplicate_status !== "pending") return jsonResponse(request, { status: ad.duplicate_status }, 200);

  try {
    if (!ad.image_storage_path) throw new Error("The original storage path is missing");
    const { data: file, error } = await admin.storage.from("ad-images").download(ad.image_storage_path);
    if (error || !file) throw new Error(error?.message || "Image download failed");
    if (file.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the scanner limit");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decoded = await decode(bytes, true);
    // dHash deliberately normalizes dimensions; the source bytes and stored image are never modified.
    decoded.resize(9, 8);
    const sha256 = await sha256Hex(bytes);
    const visualHash = differenceHash(decoded);
    const { data, error: scanError } = await admin.rpc("record_ad_duplicate_scan", {
      p_ad_id: adId,
      p_sha256_hex: sha256,
      p_visual_hash_hex: visualHash,
      p_visual_hash_version: VISUAL_HASH_VERSION,
    });
    if (scanError) throw new Error(scanError.message);
    return jsonResponse(request, data, 200);
  } catch (error) {
    // Fail closed. The row stays pending; record only bounded operational detail.
    await admin.rpc("record_ad_duplicate_scan_failure", {
      p_ad_id: adId,
      p_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown scanner failure",
    });
    return jsonResponse(request, { error: "SCAN_INCOMPLETE", status: "pending" }, 503);
  }
});

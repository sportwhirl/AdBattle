import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { decode } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { corsPreflightResponse, jsonResponse, requestOriginAllowed } from "../_shared/http.ts";
import { differenceHash, sha256Hex, VISUAL_HASH_VERSION } from "../_shared/image-fingerprint.ts";
import { cropFingerprint } from "../_shared/crop-fingerprint.ts";
import { loadOwnedImage } from "../_shared/storage-scan-policy.ts";
import {
  DuplicateScanRequestError,
  parseDuplicateScanRequest,
} from "../_shared/duplicate-scan-request.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (!requestOriginAllowed(request)) return jsonResponse(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method !== "POST") return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return jsonResponse(request, { error: "SERVER_CONFIGURATION_ERROR" }, 500);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "INVALID_WEBHOOK_PAYLOAD" }, 400);
  }
  const webhookSecret = Deno.env.get("DUPLICATE_SCANNER_WEBHOOK_SECRET") || "";
  const backfillSecret = Deno.env.get("ADBATTLE_BACKFILL_SECRET") || "";
  let adId: number;
  let legacyBackfill: boolean;
  let cropBackfill: boolean | undefined;
  try {
    ({ adId, legacyBackfill, cropBackfill } = parseDuplicateScanRequest(
      body,
      request.headers,
      webhookSecret,
      backfillSecret,
    ));
  } catch (error) {
    if (error instanceof DuplicateScanRequestError) {
      return jsonResponse(request, { error: error.code }, error.status);
    }
    return jsonResponse(request, { error: "INVALID_WEBHOOK_PAYLOAD" }, 400);
  }

  const admin = createClient(url, serviceKey);
  if (!legacyBackfill && !cropBackfill) {
    const { data: indexState, error: indexError } = await admin.from("ad_image_index_state")
      .select("ready").eq("singleton", true).single();
    if (indexError || !indexState?.ready) {
      return jsonResponse(request, { error: "INDEX_BACKFILL_INCOMPLETE", status: "pending" }, 503);
    }
  }
  const { data: ad, error: adError } = await admin.from("ads")
    .select("id,user_id,image_storage_path,duplicate_status,image_index_required,image_publication_state").eq("id", adId).single();
  if (adError || !ad) {
    return jsonResponse(request, { error: "AD_NOT_FOUND" }, 404);
  }
  if (legacyBackfill && !ad.image_index_required) return jsonResponse(request, { error: "NOT_A_LEGACY_AD" }, 409);
  if (!legacyBackfill && !cropBackfill && ad.duplicate_status !== "pending") {
    return jsonResponse(request, { status: ad.duplicate_status }, 200);
  }

  try {
    const bucket = ad.image_publication_state === "legacy_public" ? "ad-images" : "ad-pending-images";
    const bytes = await loadOwnedImage(admin.storage.from(bucket), ad.user_id, ad.image_storage_path);
    const decoded = await decode(bytes, true);
    if (!("getRGBAAt" in decoded) || typeof decoded.getRGBAAt !== "function") {
      throw new Error("The decoder did not return a supported still image");
    }
    const crop = cropFingerprint(decoded);
    const sha256 = await sha256Hex(bytes);
    if (cropBackfill) {
      const { data, error } = await admin.rpc("record_ad_crop_fingerprint", {
        p_ad_id: adId, p_sha256_hex: sha256, p_crop_fingerprint: crop,
      });
      if (error) throw new Error(error.message);
      return jsonResponse(request, data, 200);
    }
    // dHash deliberately normalizes dimensions; the source bytes and stored image are never modified.
    decoded.resize(9, 8);
    const visualHash = differenceHash(decoded);
    const rpc = legacyBackfill ? "record_ad_legacy_fingerprint" : "record_ad_duplicate_scan_v2";
    const { data, error: scanError } = await admin.rpc(rpc, {
      p_ad_id: adId,
      p_sha256_hex: sha256,
      p_visual_hash_hex: visualHash,
      p_visual_hash_version: VISUAL_HASH_VERSION,
      ...(!legacyBackfill ? { p_crop_fingerprint: crop } : {}),
    });
    if (scanError) throw new Error(scanError.message);
    if (legacyBackfill) {
      const { error } = await admin.rpc("record_ad_crop_fingerprint", {
        p_ad_id: adId, p_sha256_hex: sha256, p_crop_fingerprint: crop,
      });
      if (error) throw new Error(error.message);
    }
    return jsonResponse(request, data, 200);
  } catch (error) {
    // Fail closed. The row stays pending; record only bounded operational detail.
    if (!cropBackfill) await admin.rpc(legacyBackfill ? "record_ad_legacy_scan_failure" : "record_ad_duplicate_scan_failure", {
      p_ad_id: adId,
      p_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown scanner failure",
    });
    return jsonResponse(request, { error: "SCAN_INCOMPLETE", status: "pending" }, 503);
  }
});

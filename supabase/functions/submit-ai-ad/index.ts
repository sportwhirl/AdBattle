import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflightResponse, jsonResponse, parseBearerToken } from "../_shared/http.ts";
import { loadOwnedImage, requireImageDimensions } from "../_shared/storage-scan-policy.ts";
import { sha256Hex } from "../_shared/image-fingerprint.ts";

const STAGING_URL = "https://nccqnrcdygujulrnwair.supabase.co";
const STAGING_ORIGIN = "http://localhost:8000";
const DRAFT_BUCKET = "ai-image-drafts";
const PENDING_BUCKET = "ad-pending-images";
const MAX_POST_BYTES = 500 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseSubmission(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "caption,request_id,title" ||
      typeof body.request_id !== "string" || !UUID.test(body.request_id) ||
      typeof body.title !== "string" || typeof body.caption !== "string") return null;
  const title = body.title.trim();
  const caption = body.caption.trim();
  if (!title || title.length > 140 || !caption || caption.length > 2500 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + caption)) return null;
  return { requestId: body.request_id.toLowerCase(), title, caption };
}

type Submission = NonNullable<ReturnType<typeof parseSubmission>>;

function exactBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function boundedJson(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes || !request.body) throw new Error("INVALID_SUBMISSION");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    length += value.byteLength;
    if (length > maxBytes) { await reader.cancel(); throw new Error("INVALID_SUBMISSION"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function existingAd(
  admin: any,
  submission: Submission,
  userId: string,
  expectedPath: string,
) {
  const { data, error } = await admin.from("ads")
    .select("id,user_id,title,caption,image_storage_path")
    .eq("ai_source_request_id", submission.requestId).maybeSingle();
  if (error) throw new Error("AD_LOOKUP_FAILED");
  if (data && data.user_id !== userId) throw new Error("DRAFT_ALREADY_USED");
  if (data && (data.image_storage_path !== expectedPath ||
      data.title !== submission.title || data.caption !== submission.caption)) {
    throw new Error("SUBMISSION_CONFLICT");
  }
  return data ?? null;
}

async function uploadPendingImage(
  bucket: any,
  userId: string,
  path: string,
  bytes: Uint8Array,
  expectedHash: string,
) {
  try {
    const { error } = await bucket.upload(path, bytes, {
      contentType: "image/jpeg", cacheControl: "60", upsert: false,
    });
    if (!error) return true;
  } catch {
    // Storage can commit the object before a transport response is lost.
  }

  // The deterministic request path makes a safe retry possible only when the
  // already-stored object is byte-for-byte identical to the canonical draft.
  try {
    const stored = await loadOwnedImage(bucket, userId, path);
    return exactBytes(stored, bytes) && await sha256Hex(stored) === expectedHash;
  } catch {
    return false;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  if (request.headers.get("origin") !== STAGING_ORIGIN) {
    return jsonResponse(request, { error: "STAGING_ORIGIN_REQUIRED" }, 403);
  }
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url !== STAGING_URL || !anonKey || !serviceKey ||
      Deno.env.get("ADBATTLE_AI_IMAGE_ENABLED") !== "true" ||
      Deno.env.get("ADBATTLE_AI_IMAGE_POST_ENABLED") !== "true") {
    return jsonResponse(request, { error: "AI_POST_UNAVAILABLE" }, 503);
  }
  const token = parseBearerToken(request);
  if (!token) return jsonResponse(request, { error: "LOGIN_REQUIRED" }, 401);
  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user } = {}, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user || user.is_anonymous) {
    return jsonResponse(request, { error: "LOGIN_REQUIRED" }, 401);
  }
  if (user.app_metadata?.ai_image_adult_test_approved !== true) {
    return jsonResponse(request, { error: "ELIGIBILITY_REQUIRED" }, 403);
  }
  let body: unknown;
  try { body = await boundedJson(request, 4096); }
  catch { return jsonResponse(request, { error: "INVALID_SUBMISSION" }, 400); }
  const submission = parseSubmission(body);
  if (!submission) return jsonResponse(request, { error: "INVALID_SUBMISSION" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const path = `${user.id}/${submission.requestId}.jpg`;
  const { data: draft, error: draftError } = await admin.from("ai_image_draft_requests")
    .select("request_id,user_id,status,post_path,post_sha256,post_bytes,post_width,post_height")
    .eq("request_id", submission.requestId).eq("user_id", user.id).maybeSingle();
  if (draftError) return jsonResponse(request, { error: "DRAFT_LOOKUP_FAILED" }, 503);
  if (!draft) return jsonResponse(request, { error: "DRAFT_NOT_FOUND" }, 404);
  if (draft.status !== "completed" || !draft.post_path || !draft.post_sha256) {
    return jsonResponse(request, { error: "CANONICAL_DRAFT_UNAVAILABLE" }, 409);
  }

  try {
    const prior = await existingAd(admin, submission, user.id, path);
    if (prior !== null) return jsonResponse(request, { ad_id: prior.id, status: "submitted" });
  } catch (error) {
    if (error instanceof Error &&
        ["SUBMISSION_CONFLICT", "DRAFT_ALREADY_USED"].includes(error.message)) {
      return jsonResponse(request, { error: error.message }, 409);
    }
    return jsonResponse(request, { error: "AD_LOOKUP_FAILED" }, 503);
  }

  let bytes: Uint8Array;
  try {
    if (draft.post_path !== `${user.id}/${submission.requestId}.post.jpg` ||
        draft.post_bytes < 1 || draft.post_bytes > MAX_POST_BYTES ||
        !/^[0-9a-f]{64}$/.test(draft.post_sha256)) throw new Error("BAD_DRAFT_METADATA");
    bytes = await loadOwnedImage(admin.storage.from(DRAFT_BUCKET), user.id, draft.post_path);
    const dimensions = requireImageDimensions(bytes, "image/jpeg");
    if (bytes.byteLength !== draft.post_bytes || bytes.byteLength > MAX_POST_BYTES ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
        dimensions.width !== draft.post_width || dimensions.height !== draft.post_height ||
        !((dimensions.width === 640 && dimensions.height === 640) ||
          (dimensions.width === 640 && dimensions.height === 360)) ||
        await sha256Hex(bytes) !== draft.post_sha256) throw new Error("BAD_DRAFT_BYTES");
  } catch {
    return jsonResponse(request, { error: "CANONICAL_DRAFT_INVALID" }, 503);
  }

  const pending = admin.storage.from(PENDING_BUCKET);
  if (!await uploadPendingImage(pending, user.id, path, bytes, draft.post_sha256)) {
    return jsonResponse(request, { error: "PRIVATE_AD_UPLOAD_FAILED" }, 503);
  }

  let ad: { id: number } | null = null;
  let insertError: unknown;
  try {
    const result = await admin.from("ads")
      .insert({ user_id: user.id, title: submission.title, caption: submission.caption,
        image_url: "", image_storage_path: path,
        ai_source_request_id: submission.requestId })
      .select("id").single();
    ad = result.data;
    insertError = result.error;
  } catch (error) {
    insertError = error;
  }
  if (insertError || !ad) {
    // An error can be a lost response after a committed INSERT. Re-read the
    // authoritative row before cleanup, and retain the private object whenever
    // that read is unavailable or otherwise inconclusive.
    let prior: { id: number; user_id: string; title: string; caption: string;
      image_storage_path: string } | null;
    try {
      prior = await existingAd(admin, submission, user.id, path);
    } catch (error) {
      if (error instanceof Error &&
          ["SUBMISSION_CONFLICT", "DRAFT_ALREADY_USED"].includes(error.message)) {
        return jsonResponse(request, { error: error.message }, 409);
      }
      return jsonResponse(request, { error: "AD_INSERT_FAILED" }, 503);
    }
    if (prior !== null) {
      return jsonResponse(request, { ad_id: prior.id, status: "submitted" });
    }
    // postgrest-js can return a fetch/connection failure as `error` instead
    // of throwing. The INSERT may still be finishing, so a momentary absence
    // is never proof that this deterministic path is unreferenced.
    return jsonResponse(request, { error: "AD_INSERT_FAILED" }, 503);
  }
  return jsonResponse(request, { ad_id: ad.id, status: "submitted" }, 200);
});

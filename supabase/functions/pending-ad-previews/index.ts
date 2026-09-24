import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflightResponse, jsonResponse, parseBearerToken, requestOriginAllowed } from "../_shared/http.ts";
import { requireOwnedStoragePath } from "../_shared/storage-scan-policy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (!requestOriginAllowed(request)) return jsonResponse(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method !== "POST") return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = parseBearerToken(request);
  if (!url || !serviceKey) return jsonResponse(request, { error: "SERVER_CONFIGURATION_ERROR" }, 503);
  if (!token) return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth?.user?.id) return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  let ids: number[];
  try {
    if (Number(request.headers.get("content-length")) > 2048) throw new Error();
    const body = await request.json();
    ids = body?.ad_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(ids).size !== ids.length) throw new Error();
  } catch { return jsonResponse(request, { error: "INVALID_REQUEST" }, 400); }
  const { data: rows, error } = await admin.from("ads")
    .select("id,user_id,image_storage_path,moderation_status,image_publication_state")
    .in("id", ids);
  if (error || !rows) return jsonResponse(request, { error: "PREVIEW_UNAVAILABLE" }, 503);
  if (rows.length !== ids.length || rows.some(row => row.user_id !== auth.user.id ||
      row.moderation_status !== "pending_scan" ||
      !["pending", "publishing"].includes(row.image_publication_state))) {
    return jsonResponse(request, { error: "PREVIEW_UNAVAILABLE" }, 403);
  }
  const previews: Record<number, string> = {};
  for (const row of rows) {
    let path: string;
    try { path = requireOwnedStoragePath(auth.user.id, row.image_storage_path); }
    catch { return jsonResponse(request, { error: "PREVIEW_UNAVAILABLE" }, 503); }
    const { data: signed, error: signError } = await admin.storage
      .from("ad-pending-images").createSignedUrl(path, 60);
    if (signError || !signed?.signedUrl) return jsonResponse(request, { error: "PREVIEW_UNAVAILABLE" }, 503);
    previews[row.id] = signed.signedUrl;
  }
  const response = jsonResponse(request, { previews }, 200);
  response.headers.set("Cache-Control", "no-store");
  return response;
});

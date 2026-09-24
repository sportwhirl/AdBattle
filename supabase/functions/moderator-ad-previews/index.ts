import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflightResponse, jsonResponse, parseBearerToken, requestOriginAllowed } from "../_shared/http.ts";
import { requireOwnedStoragePath } from "../_shared/storage-scan-policy.ts";

const held = (ad: any) => ad?.moderation_status !== "removed" &&
  (ad?.safety_status === "held" || ["review_identical", "review_similar"].includes(ad?.duplicate_status));

Deno.serve(async (request) => {
  const reply = (body: unknown, status = 200) => {
    const response = jsonResponse(request, body, status);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (!requestOriginAllowed(request)) return reply({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method !== "POST") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  const token = parseBearerToken(request);
  if (!url || !serviceKey || !publicKey) return reply({ error: "PREVIEW_UNAVAILABLE" }, 503);
  if (!token) return reply({ error: "UNAUTHORIZED" }, 401);
  try {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth?.user?.id) return reply({ error: "UNAUTHORIZED" }, 401);
    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 1024) throw new Error();
      body = JSON.parse(raw);
      if (!body || Object.keys(body).sort().join(",") !== "ad_id,expected_version" ||
          typeof body.ad_id !== "string" || !/^[1-9][0-9]{0,18}$/.test(body.ad_id) ||
          BigInt(body.ad_id) > 9223372036854775807n ||
          typeof body.expected_version !== "string" || !/^[0-9a-f]{32}$/.test(body.expected_version)) throw new Error();
    } catch { return reply({ error: "INVALID_REQUEST" }, 400); }

    // Forward the verified user's JWT, never a service-role claim, to the
    // existing live allowlist/session guard. Ownership alone grants no review access.
    const reviewer = createClient(url, publicKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const read = () => reviewer.rpc("moderator_ad", { p_ad_id: body.ad_id });
    const denied = (error: any) => error?.code === "42501" || error?.message === "MODERATOR_ACCESS_REQUIRED";
    const { data: detail, error } = await read();
    if (error) return reply({ error: denied(error) ? "MODERATOR_ACCESS_REQUIRED" : "PREVIEW_UNAVAILABLE" }, denied(error) ? 403 : 503);
    if (!detail || detail.ad?.id !== body.ad_id || detail.version !== body.expected_version || !held(detail.ad)) {
      return reply({ error: "REVIEW_CHANGED_REFRESH_REQUIRED" }, 409);
    }
    // Only the reviewed ad and its authoritative match may be signed. The
    // browser cannot choose an owner, bucket, object path or second ad ID.
    const ads = [detail.ad, ...(detail.ad.matched_ad ? [detail.ad.matched_ad] : [])];
    const ids = [...new Set(ads.map(ad => ad.id))];
    const { data: rows, error: rowsError } = await admin.from("ads")
      .select("id,user_id,image_storage_path,image_publication_state")
      .in("id", ids);
    if (rowsError || !rows || rows.length !== ids.length) return reply({ error: "PREVIEW_UNAVAILABLE" }, 503);
    const previews: Record<string, string> = {};
    for (const ad of ads) {
      const row = rows.find(row => String(row.id) === ad.id);
      if (!row || row.user_id !== ad.owner_id || row.image_storage_path !== ad.image_storage_path ||
          !["pending", "publishing", "public", "legacy_public"].includes(row.image_publication_state)) {
        return reply({ error: "PREVIEW_UNAVAILABLE" }, 503);
      }
      const path = requireOwnedStoragePath(row.user_id, row.image_storage_path);
      if (/[\x00-\x1f\x7f%?#]/.test(path)) return reply({ error: "PREVIEW_UNAVAILABLE" }, 503);
      // Modern ads retain the original private bytes after publication.
      // Historic approved images have only their legacy public object.
      const bucket = row.image_publication_state === "legacy_public" ? "ad-images" : "ad-pending-images";
      const { data: signed, error: signError } = await admin.storage.from(bucket).createSignedUrl(path, 60);
      if (signError || !signed?.signedUrl) return reply({ error: "PREVIEW_UNAVAILABLE" }, 503);
      previews[ad.id] = signed.signedUrl;
    }
    // Recheck live membership/session and the full review snapshot after the
    // Storage calls. A revoked or changed review receives no signed URLs.
    const { data: fresh, error: freshError } = await read();
    if (freshError) return reply({ error: denied(freshError) ? "MODERATOR_ACCESS_REQUIRED" : "PREVIEW_UNAVAILABLE" }, denied(freshError) ? 403 : 503);
    if (fresh?.ad?.id !== body.ad_id || fresh.version !== detail.version || !held(fresh.ad)) {
      return reply({ error: "REVIEW_CHANGED_REFRESH_REQUIRED" }, 409);
    }
    return reply({ ad_id: body.ad_id, version: detail.version, expires_in: 60, previews });
  } catch {
    // Never return provider errors or log bearer/signed tokens.
    return reply({ error: "PREVIEW_UNAVAILABLE" }, 503);
  }
});

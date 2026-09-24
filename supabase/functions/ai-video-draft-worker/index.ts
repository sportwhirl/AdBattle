import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import { assertStaging, boundedJson, STAGING_URL } from '../_shared/ai-video-draft.mjs';
import { isUuid } from '../_shared/http.ts';

// Manual prompt review only. A separate private GPU worker claims queued jobs.
const REVIEW_ATTESTATION = 'I reviewed this exact prompt against the AdBattle video safety rules';
function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function secretMatches(actual: string | null, expected: string | undefined) {
  if (!expected || expected.length < 32 || !actual || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' || req.headers.has('origin')) return response({ error: 'Unavailable.' }, 405);
  try {
    assertStaging({ SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
      ADBATTLE_AI_STAGING_ENABLED: Deno.env.get('ADBATTLE_AI_STAGING_ENABLED') });
  } catch { return response({ error: 'Unavailable.' }, 503); }
  if (!secretMatches(req.headers.get('x-adbattle-video-worker-secret'),
    Deno.env.get('ADBATTLE_VIDEO_WORKER_SECRET'))) return response({ error: 'Unauthorized.' }, 401);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) return response({ error: 'Unavailable.' }, 503);
  let body: Record<string, unknown>;
  try { body = await boundedJson(req, 2048); }
  catch { return response({ error: 'Invalid request.' }, 400); }
  const db = createClient(STAGING_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!isUuid(body?.job_id)) return response({ error: 'Invalid job ID.' }, 400);
  if (body.action === 'inspect') {
    const { data, error } = await db.from('ai_video_draft_jobs')
      .select('id,prompt,aspect_ratio,style,request_hash,status')
      .eq('id', body.job_id).maybeSingle();
    if (error) return response({ error: 'Read failed.' }, 503);
    return data ? response({ job: data }) : response({ error: 'Not found.' }, 404);
  }
  if (body.action !== 'approve' && body.action !== 'reject') {
    return response({ error: 'Unsupported action.' }, 400);
  }
  if (!/^[0-9a-f]{64}$/.test(String(body.request_hash)) ||
      typeof body.reviewer !== 'string' || !/^[\w .@-]{3,64}$/.test(body.reviewer) ||
      (body.action === 'approve' && body.review_attestation !== REVIEW_ATTESTATION)) {
    return response({ error: 'Invalid review.' }, 400);
  }
  const now = new Date().toISOString();
  const patch = body.action === 'approve'
    ? { status: 'queued', reviewed_at: now, reviewed_by: body.reviewer,
        reviewed_request_hash: body.request_hash, updated_at: now }
    : { status: 'rejected', reviewed_at: now, reviewed_by: body.reviewer,
        reviewed_request_hash: body.request_hash, error_code: 'REJECTED_BY_REVIEW', updated_at: now };
  const { data, error } = await db.from('ai_video_draft_jobs').update(patch)
    .eq('id', body.job_id).eq('request_hash', body.request_hash)
    .eq('status', 'pending_review').select('id').maybeSingle();
  if (error) return response({ error: 'Review update failed.' }, 503);
  return data ? response({ job_id: data.id, status: patch.status })
    : response({ error: 'Draft changed or is no longer pending review.' }, 409);
});

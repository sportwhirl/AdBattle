import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import { adultTestApproved, assertStaging, boundedJson, draftHash, normalizeDraft,
  STAGING_ORIGIN, STAGING_URL } from '../_shared/ai-video-draft.mjs';
import { isUuid, parseBearerToken } from '../_shared/http.ts';

function reply(req: Request, body: Record<string, unknown>, status = 200) {
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'vary': 'Origin', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  if (req.headers.get('origin') === STAGING_ORIGIN) headers['access-control-allow-origin'] = STAGING_ORIGIN;
  return new Response(JSON.stringify(body), { status, headers });
}

function summary(row: Record<string, unknown>) {
  return { id: row.id, request_id: row.request_id, status: row.status,
    aspect_ratio: row.aspect_ratio, style: row.style, audio_required: row.audio_required,
    error_code: row.error_code,
    created_at: row.created_at, updated_at: row.updated_at };
}

Deno.serve(async (req) => {
  if (req.headers.get('origin') && req.headers.get('origin') !== STAGING_ORIGIN) {
    return reply(req, { error: 'Origin is not allowed.' }, 403);
  }
  try {
    assertStaging({ SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
      ADBATTLE_AI_STAGING_ENABLED: Deno.env.get('ADBATTLE_AI_STAGING_ENABLED') });
  } catch { return reply(req, { error: 'Video drafts are unavailable.' }, 503); }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: reply(req, {}).headers });
  if (req.method !== 'POST') return reply(req, { error: 'Method not allowed.' }, 405);
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!anonKey || !serviceKey) return reply(req, { error: 'Video drafts are unavailable.' }, 503);
  const token = parseBearerToken(req);
  if (!token) return reply(req, { error: 'Sign in to request a draft.' }, 401);
  const auth = createClient(STAGING_URL, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: authError } = await auth.auth.getUser(token);
  if (authError || !user || user.is_anonymous) return reply(req, { error: 'Invalid session.' }, 401);
  const admin = createClient(STAGING_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: Record<string, unknown>;
  try { body = await boundedJson(req, 4096); }
  catch { return reply(req, { error: 'Invalid request body.' }, 400); }
  if (body?.action === 'status') {
    if (!isUuid(body.job_id)) return reply(req, { error: 'Invalid job ID.' }, 400);
    const { data, error } = await admin.from('ai_video_draft_jobs')
      .select('id,request_id,status,aspect_ratio,style,audio_required,error_code,created_at,updated_at')
      .eq('id', body.job_id).eq('user_id', user.id).maybeSingle();
    if (error) return reply(req, { error: 'Could not read draft.' }, 503);
    return data ? reply(req, { job: summary(data) }) : reply(req, { error: 'Draft not found.' }, 404);
  }
  if (!adultTestApproved(user)) {
    return reply(req, { error: 'Video drafts are limited to approved adult staging testers.' }, 403);
  }
  if (body?.action !== 'create' || !isUuid(body.request_id)) {
    return reply(req, { error: 'Invalid draft request.' }, 400);
  }
  let draft;
  try { draft = normalizeDraft(body); }
  catch { return reply(req, { error: 'Prompt or output format is invalid.' }, 400); }
  const hash = await draftHash(draft);
  const select = 'id,request_id,request_hash,status,aspect_ratio,style,audio_required,error_code,created_at,updated_at';
  const existing = async () => admin.from('ai_video_draft_jobs').select(select)
    .eq('user_id', user.id).eq('request_id', body.request_id).maybeSingle();
  const old = await existing();
  if (old.error) return reply(req, { error: 'Could not check draft request.' }, 503);
  if (old.data) return old.data.request_hash === hash
    ? reply(req, { job: summary(old.data) })
    : reply(req, { error: 'Request ID was already used for a different draft.' }, 409);

  const { data, error } = await admin.from('ai_video_draft_jobs').insert({
    user_id: user.id, request_id: body.request_id, request_hash: hash,
    prompt: draft.prompt, aspect_ratio: draft.aspect_ratio, style: draft.style,
  }).select(select).single();
  if (error) {
    // The same UUID may have won a concurrent race. Never create a new ID for it.
    const raced = await existing();
    if (!raced.error && raced.data) return raced.data.request_hash === hash
      ? reply(req, { job: summary(raced.data) })
      : reply(req, { error: 'Request ID was already used for a different draft.' }, 409);
    if (error.message.includes('AI_VIDEO_USER_DAILY_LIMIT') ||
        error.message.includes('AI_VIDEO_GLOBAL_DAILY_LIMIT')) {
      return reply(req, { error: 'Video draft limit reached for today (UTC).' }, 429);
    }
    if (error.code === '23505') return reply(req, { error: 'An active video draft already exists.' }, 409);
    return reply(req, { error: 'Could not create draft.' }, 503);
  }
  return reply(req, { job: summary(data) }, 202);
});

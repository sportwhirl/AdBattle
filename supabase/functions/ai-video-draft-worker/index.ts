import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import { adultTestApproved, assertStaging, boundedJson, generationIdValid, generationResult,
  paidDispatchOnce, providerCall, STAGING_URL } from '../_shared/ai-video-draft.mjs';
import { isUuid } from '../_shared/http.ts';

const JOBS = 'ai_video_draft_jobs';
const REVIEW_ATTESTATION = 'I reviewed this exact prompt against the AdBattle video safety rules';
const FIELDS = 'id,user_id,request_id,request_hash,prompt,aspect_ratio,style,status,reviewed_at,reviewed_request_hash,provider_generation_id,provider_output_url,provider_deadline_at,next_poll_at';
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
function later(seconds: number) { return new Date(Date.now() + seconds * 1000).toISOString(); }

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
  const now = new Date().toISOString();

  if (body?.action === 'inspect') {
    if (!isUuid(body.job_id)) return response({ error: 'Invalid job ID.' }, 400);
    const { data, error } = await db.from(JOBS).select(FIELDS).eq('id', body.job_id).maybeSingle();
    if (error) return response({ error: 'Read failed.' }, 503);
    return data ? response({ job: { id: data.id, prompt: data.prompt,
      aspect_ratio: data.aspect_ratio, style: data.style, request_hash: data.request_hash,
      status: data.status } }) : response({ error: 'Not found.' }, 404);
  }
  if (body?.action === 'approve' || body?.action === 'reject') {
    if (!isUuid(body.job_id) || !/^[0-9a-f]{64}$/.test(String(body.request_hash)) ||
        typeof body.reviewer !== 'string' || !/^[\w .@-]{3,64}$/.test(body.reviewer)) {
      return response({ error: 'Invalid review.' }, 400);
    }
    if (body.action === 'approve' && body.review_attestation !== REVIEW_ATTESTATION) {
      return response({ error: 'Explicit safety review attestation is required.' }, 400);
    }
    const patch = body.action === 'approve'
      ? { status: 'queued', reviewed_at: now, reviewed_by: body.reviewer,
          reviewed_request_hash: body.request_hash, updated_at: now }
      : { status: 'rejected', reviewed_at: now, reviewed_by: body.reviewer,
          reviewed_request_hash: body.request_hash, error_code: 'REJECTED_BY_REVIEW', updated_at: now };
    const { data, error } = await db.from(JOBS).update(patch).eq('id', body.job_id)
      .eq('request_hash', body.request_hash).eq('status', 'pending_review').select('id').maybeSingle();
    if (error) return response({ error: 'Review update failed.' }, 503);
    return data ? response({ job_id: data.id, status: patch.status })
      : response({ error: 'Draft changed or is no longer pending review.' }, 409);
  }

  if (body?.action === 'dispatch') {
    const apiKey = Deno.env.get('LUMA_AGENTS_API_KEY');
    if (!apiKey) return response({ error: 'Provider is not configured.' }, 503);
    const { data: jobs, error } = await db.from(JOBS).select(FIELDS).eq('status', 'queued')
      .not('reviewed_at', 'is', null).order('created_at').limit(1);
    if (error) return response({ error: 'Claim failed.' }, 503);
    const job = jobs?.[0];
    if (!job) return response({ status: 'idle' });
    if (job.reviewed_request_hash !== job.request_hash) return response({ error: 'Review binding failed.' }, 409);
    const { data: account, error: accountError } = await db.auth.admin.getUserById(job.user_id);
    if (accountError || !account?.user) return response({ error: 'Adult staging eligibility could not be checked.' }, 503);
    if (!adultTestApproved(account.user)) {
      await db.from(JOBS).update({ status: 'needs_review', error_code: 'ADULT_TEST_ACCESS_REVOKED',
        updated_at: now }).eq('id', job.id).eq('status', 'queued');
      return response({ error: 'Staging eligibility is unavailable.' }, 403);
    }
    const claim = await db.from(JOBS).update({ status: 'dispatching', updated_at: now })
      .eq('id', job.id).eq('status', 'queued').eq('request_hash', job.request_hash)
      .select('id').maybeSingle();
    if (claim.error) return response({ error: 'Claim failed.' }, 503);
    if (!claim.data) return response({ status: 'claimed_elsewhere' });
    // Once claimed, NEVER POST this job again. A crash, timeout, malformed
    // reply or lost DB write may mean Luma already accepted the paid call.
    try {
      const result = await paidDispatchOnce(job,
        (providerBody: Record<string, unknown>) => providerCall(fetch, apiKey, 'generations', {
          method: 'POST', body: JSON.stringify(providerBody),
        }),
        async (patch: Record<string, unknown>, providerId?: string | null) => {
          // Retrying this DB write is safe; retrying the provider POST is not.
          for (let attempt = 0; attempt < 3; attempt++) {
            const saved = await db.from(JOBS).update({ ...patch, updated_at: new Date().toISOString() })
              .eq('id', job.id).eq('status', 'dispatching').select('id').maybeSingle();
            if (!saved.error && saved.data) return;
          }
          console.error('AI_VIDEO_PROVIDER_ID_PERSIST_FAILED', { job_id: job.id,
            provider_generation_id: providerId || null });
          throw new Error('AI_VIDEO_PERSIST_FAILED');
        }, later);
      return response({ job_id: job.id, status: result.status }, 202);
    } catch { return response({ error: 'Provider state needs operator reconciliation.' }, 503); }
  }

  if (body?.action === 'poll') {
    const apiKey = Deno.env.get('LUMA_AGENTS_API_KEY');
    if (!apiKey) return response({ error: 'Provider is not configured.' }, 503);
    const { data: jobs, error } = await db.from(JOBS).select(FIELDS)
      .in('status', ['in_progress', 'polling'])
      .lte('next_poll_at', now).order('next_poll_at').limit(1);
    if (error) return response({ error: 'Poll claim failed.' }, 503);
    const job = jobs?.[0];
    if (!job) return response({ status: 'idle' });
    const claim = await db.from(JOBS).update({ status: 'polling', next_poll_at: later(120),
      updated_at: now }).eq('id', job.id).eq('status', job.status)
      .lte('next_poll_at', now).select('id').maybeSingle();
    if (claim.error) return response({ error: 'Poll claim failed.' }, 503);
    if (!claim.data) return response({ status: 'claimed_elsewhere' });
    let patch: Record<string, unknown>;
    try {
      if (!generationIdValid(job.provider_generation_id)) throw new Error('INVALID_GENERATION');
      if (!job.provider_deadline_at || Date.now() >= Date.parse(job.provider_deadline_at)) {
        patch = { status: 'needs_review', next_poll_at: null, error_code: 'PROVIDER_POLL_DEADLINE' };
      } else {
        const raw = await providerCall(fetch, apiKey,
          `generations/${encodeURIComponent(job.provider_generation_id)}`);
        const result = generationResult(raw, job.provider_generation_id);
        if (result.kind === 'in_progress') patch = { status: 'in_progress', next_poll_at: later(30) };
        else if (result.kind === 'ready') patch = { status: 'ready_for_processing',
          provider_output_url: result.output_url, next_poll_at: null, error_code: null };
        else patch = { status: result.kind === 'failed' ? 'failed' : 'needs_review',
          error_code: result.code, next_poll_at: null };
      }
    } catch (error) {
      const malformed = error instanceof Error &&
        ['PROVIDER_RESPONSE_TOO_LARGE', 'INVALID_PROVIDER_JSON',
          'INVALID_GENERATION'].includes(error.message);
      // Bad or oversized responses need manual review; transient GET failures
      // can be retried without starting another paid generation.
      patch = malformed
        ? { status: 'needs_review', next_poll_at: null, error_code: 'INVALID_PROVIDER_RESPONSE' }
        : { status: 'in_progress', next_poll_at: later(60), error_code: 'PROVIDER_POLL_ERROR' };
    }
    const saved = await db.from(JOBS).update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'polling').select('id').maybeSingle();
    if (saved.error || !saved.data) return response({ error: 'Poll state needs reconciliation.' }, 503);
    return response({ job_id: job.id, status: patch.status }, 202);
  }
  return response({ error: 'Unsupported action.' }, 400);
});

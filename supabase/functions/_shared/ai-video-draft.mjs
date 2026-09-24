// Pure, testable rules shared by the two staging-only Edge Functions.
export const STAGING_URL = 'https://nccqnrcdygujulrnwair.supabase.co';
export const STAGING_ORIGIN = 'http://localhost:8000';
export const MODEL = 'ray-3.2';
export const API_BASE = 'https://agents.lumalabs.ai/v1';
export const STAGING_FEATURE = 'video-audio-drafts-v2';
export const AUDIO_REQUIRED = true;
export const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
export const MAX_DOWNLOAD_URL_LENGTH = 8192;
export const STYLES = Object.freeze({
  pixel_art: 'pixel art animation with crisp blocky pixels, a limited palette and simple motion',
  flat_illustration: 'flat illustration animation with simple shapes, clean outlines and limited colors',
  simple_3d: 'simple low polygon 3D game art, restrained lighting and limited textures',
  hand_drawn: 'hand drawn animation with visible pencil or ink strokes and a restrained palette',
  freeform_simple: 'a visual style chosen to fit the idea',
});

export function assertStaging(env) {
  if (env.SUPABASE_URL !== STAGING_URL ||
      env.ADBATTLE_AI_STAGING_ENABLED !== STAGING_FEATURE) {
    throw new Error('AI_VIDEO_STAGING_GUARD');
  }
}

export function adultTestApproved(user) {
  return user?.app_metadata?.ai_video_adult_test_approved === true;
}

export function normalizeDraft(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_DRAFT');
  const prompt = typeof body.prompt === 'string'
    ? body.prompt.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
  if (prompt.length < 12 || prompt.length > 600 || /[\p{Cc}\p{Cf}]/u.test(prompt)) {
    throw new Error('INVALID_PROMPT');
  }
  const aspectRatio = body.aspect_ratio;
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16') throw new Error('INVALID_ASPECT_RATIO');
  const style = body.style ?? 'freeform_simple';
  if (!Object.hasOwn(STYLES, style)) throw new Error('INVALID_STYLE');
  // Unknown knobs must not let callers select a model, duration, resolution,
  // edit/reference media, HDR, search, uploaded media, or provider settings.
  if (Object.keys(body).some((key) => !['action', 'prompt', 'aspect_ratio', 'style', 'request_id'].includes(key))) {
    throw new Error('UNSUPPORTED_PARAMETER');
  }
  return { prompt, aspect_ratio: aspectRatio, style };
}

export async function draftHash(draft) {
  const payload = JSON.stringify({ version: 3, model: MODEL, duration: '10s',
    resolution: '360p', audio_required: AUDIO_REQUIRED,
    aspect_ratio: draft.aspect_ratio, style: draft.style, prompt: draft.prompt });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function providerRequest(job) {
  const style = job.style === 'freeform_simple'
    ? 'Choose a visual style that fits the idea.'
    : `Use ${STYLES[job.style]} as a creative direction.`;
  return {
    model: MODEL,
    type: 'video',
    prompt: `Create a ten-second ad draft with one synchronized, original AI-generated soundtrack. ` +
      `${style} Keep the key subject legible at 360p. Do not imitate a named artist, celebrity, ` +
      `copyrighted song, or real person's voice. Creative direction: ${job.prompt}`,
    aspect_ratio: job.aspect_ratio,
    video: { resolution: '360p', duration: '10s' },
    web_search: false,
  };
}

export function generationIdValid(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function validatedDownloadUrl(value) {
  if (typeof value !== 'string' || value.length < 16 ||
      value.length > MAX_DOWNLOAD_URL_LENGTH || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.hash || parsed.port || !parsed.pathname || parsed.pathname === '/') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  // The provider's presigned storage host is not documented as a stable name.
  // Reject local/opaque hosts now; the later downloader must also enforce its
  // own host allowlist, DNS/IP checks, redirect policy and byte limits.
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      /(^|\.)(localhost|local|internal|test|invalid|example|lan)$/.test(host)) return null;
  return value;
}

/** @param {any} raw @param {string|null} [expectedId] */
export function generationResult(raw, expectedId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !generationIdValid(raw.id) || (expectedId && raw.id !== expectedId)) {
    return { kind: 'needs_review', code: 'INVALID_GENERATION' };
  }
  if (raw.model !== MODEL || raw.type !== 'video') {
    return { kind: 'needs_review', code: 'PROVIDER_TYPE_MISMATCH', id: raw.id };
  }
  if (raw.state === 'queued' || raw.state === 'processing') {
    return { kind: 'in_progress', id: raw.id };
  }
  if (raw.state === 'failed') {
    const safeFailure = ['content_moderated', 'generation_failed', 'budget_exhausted',
      'output_not_found', 'rate_limited'].includes(raw.failure_code)
      ? raw.failure_code.toUpperCase() : 'FAILED';
    return { kind: 'failed', code: `PROVIDER_${safeFailure}`, id: raw.id };
  }
  if (raw.state !== 'completed') {
    return { kind: 'needs_review', code: 'UNKNOWN_PROVIDER_STATE', id: raw.id };
  }
  if (!Array.isArray(raw.output) || raw.output.length !== 1 ||
      raw.output[0]?.type !== 'video' ||
      !validatedDownloadUrl(raw.output[0].url) ||
      raw.output[0].data != null || raw.output[0].base64 != null) {
    return { kind: 'needs_review', code: 'INVALID_VIDEO_OUTPUT', id: raw.id };
  }
  return { kind: 'ready', id: raw.id, output_url: raw.output[0].url };
}

export async function paidDispatchOnce(job, sendPost, persist, nextPoll) {
  let raw;
  try {
    // No retry here, including transport timeout or a malformed response.
    raw = await sendPost(providerRequest(job));
  } catch (error) {
    const code = error instanceof Error && /^PROVIDER_[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'PROVIDER_DISPATCH_UNCERTAIN';
    await persist({ status: 'dispatch_unknown', error_code: code });
    return { status: 'dispatch_unknown' };
  }
  const result = generationResult(raw);
  const patch = { provider_generation_id: result.id || null, error_code: result.code || null };
  if (result.kind === 'in_progress') Object.assign(patch, { status: 'in_progress',
    next_poll_at: nextPoll(30), provider_deadline_at: nextPoll(600) });
  else if (result.kind === 'ready') Object.assign(patch, { status: 'ready_for_processing',
    provider_output_url: result.output_url });
  else Object.assign(patch, { status: result.kind === 'failed' ? 'failed' : 'needs_review' });
  // Persistence may retry; paid creation never does.
  await persist(patch, result.id || null);
  return { status: patch.status };
}

export async function boundedJson(response, limit = MAX_PROVIDER_JSON_BYTES) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new Error('EMPTY_PROVIDER_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('INVALID_PROVIDER_JSON'); }
}

export async function providerCall(fetcher, apiKey, path, options = {}) {
  // URL is constructed from fixed endpoints and validated identifiers only.
  const response = await fetcher(`${API_BASE}/${path}`, {
    ...options,
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(options.method === 'POST' ? 25000 : 10000),
  });
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  return body;
}

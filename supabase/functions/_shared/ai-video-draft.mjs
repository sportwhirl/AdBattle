// Pure, testable rules shared by the two staging-only Edge Functions.
export const STAGING_URL = 'https://nccqnrcdygujulrnwair.supabase.co';
export const STAGING_ORIGIN = 'http://localhost:8000';
export const MODEL = 'gemini-omni-1.1-flash';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
export const STYLES = Object.freeze({
  pixel_art: 'pixel art animation with crisp blocky pixels, a limited palette and simple motion',
  flat_illustration: 'flat illustration animation with simple shapes, clean outlines and limited colors',
  simple_3d: 'simple low polygon 3D game art, restrained lighting and limited textures',
  hand_drawn: 'hand drawn animation with visible pencil or ink strokes and a restrained palette',
  freeform_simple: 'a simple stylized visual treatment chosen to suit the idea, with restrained detail',
});

export function assertStaging(env) {
  if (env.SUPABASE_URL !== STAGING_URL ||
      env.ADBATTLE_AI_STAGING_ENABLED !== 'video-drafts-v1') {
    throw new Error('AI_VIDEO_STAGING_GUARD');
  }
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
  // previous interaction, uploaded media, or system instructions.
  if (Object.keys(body).some((key) => !['action', 'prompt', 'aspect_ratio', 'style', 'request_id'].includes(key))) {
    throw new Error('UNSUPPORTED_PARAMETER');
  }
  return { prompt, aspect_ratio: aspectRatio, style };
}

export async function draftHash(draft) {
  const payload = JSON.stringify({ version: 1, model: MODEL, duration: '10s',
    resolution: '360p', aspect_ratio: draft.aspect_ratio, style: draft.style, prompt: draft.prompt });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function providerRequest(job) {
  return {
    model: MODEL,
    input: `Create a ten-second ad draft in ${STYLES[job.style]}. Use a simple, readable composition and clear motion. Avoid crowded detail. Creative direction: ${job.prompt}`,
    response_format: { type: 'video', duration: '10s', resolution: '360p',
      aspect_ratio: job.aspect_ratio, delivery: 'uri' },
    background: true,
    store: true,
    stream: false,
  };
}

export function fileNameFromUri(uri) {
  if (typeof uri !== 'string' || uri.length > 512) return null;
  // Google documents either files/<id> or its own absolute Files API URI.
  let path = uri;
  if (uri.startsWith('https://')) {
    let url;
    try { url = new URL(uri); } catch { return null; }
    if (url.origin !== 'https://generativelanguage.googleapis.com' ||
        url.search || url.hash || url.username || url.password) return null;
    path = url.pathname.replace(/^\/(?:v1|v1beta)\//, '');
  }
  return /^files\/[A-Za-z0-9_-]{1,200}$/.test(path) ? path : null;
}

/** @param {any} raw @param {string|null} [expectedId] */
export function interactionResult(raw, expectedId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(raw.id) ||
      (expectedId && raw.id !== expectedId)) return { kind: 'needs_review', code: 'INVALID_INTERACTION' };
  if (raw.model && raw.model !== MODEL && raw.model !== `models/${MODEL}`) {
    return { kind: 'needs_review', code: 'MODEL_MISMATCH', id: raw.id };
  }
  if (raw.status === 'in_progress') return { kind: 'in_progress', id: raw.id };
  if (['failed', 'cancelled', 'incomplete', 'requires_action'].includes(raw.status)) {
    return { kind: 'failed', code: `PROVIDER_${raw.status.toUpperCase()}`, id: raw.id };
  }
  if (raw.status !== 'completed') return { kind: 'needs_review', code: 'UNKNOWN_PROVIDER_STATUS', id: raw.id };

  const outputs = [];
  if (Array.isArray(raw.steps)) {
    for (const step of raw.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const content of step.content) if (content?.type === 'video') outputs.push(content);
    }
  }
  // The Omni REST guide also documents output_video.uri on some responses.
  if (raw.output_video && typeof raw.output_video === 'object') outputs.push(raw.output_video);
  if (outputs.some((part) => part.data != null || part.inline_data != null)) {
    return { kind: 'needs_review', code: 'UNEXPECTED_INLINE_VIDEO', id: raw.id };
  }
  const uris = [...new Set(outputs.map((part) => part.uri))];
  if (uris.length !== 1 || !fileNameFromUri(uris[0]) ||
      outputs.some((part) => part.mime_type && part.mime_type !== 'video/mp4')) {
    return { kind: 'needs_review', code: 'INVALID_VIDEO_URI', id: raw.id };
  }
  return { kind: 'file_pending', id: raw.id, file_uri: uris[0],
    file_name: fileNameFromUri(uris[0]) };
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
  const result = interactionResult(raw);
  const patch = { provider_interaction_id: result.id || null, error_code: result.code || null };
  if (result.kind === 'in_progress') Object.assign(patch, { status: 'in_progress',
    next_poll_at: nextPoll(30) });
  else if (result.kind === 'file_pending') Object.assign(patch, { status: 'waiting_for_file',
    provider_file_uri: result.file_uri, provider_file_name: result.file_name,
    next_poll_at: nextPoll(15) });
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
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(options.method === 'POST' ? 25000 : 10000),
  });
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  return body;
}

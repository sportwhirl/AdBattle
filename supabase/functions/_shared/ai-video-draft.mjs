// Staging-only Wan2.1 text-to-video draft rules. No browser path invokes a GPU directly.
export const STAGING_URL = 'https://nccqnrcdygujulrnwair.supabase.co';
export const STAGING_ORIGIN = 'http://localhost:8000';
export const MODEL = 'Wan-AI/Wan2.1-T2V-1.3B';
export const STYLES = Object.freeze({
  pixel_art: 'pixel art, crisp blocky pixels, a limited palette and simple motion',
  flat_illustration: 'flat illustration, clean outlines and limited colors',
  simple_3d: 'simple low polygon 3D game art and restrained textures',
  hand_drawn: 'hand drawn art with visible pencil or ink strokes',
  freeform_simple: 'a visual style chosen to fit the idea',
});

export function assertStaging(env) {
  if (env.SUPABASE_URL !== STAGING_URL ||
      env.ADBATTLE_AI_STAGING_ENABLED !== 'video-drafts-v1') {
    throw new Error('AI_VIDEO_STAGING_GUARD');
  }
}

export function adultTestApproved(user) {
  return user?.app_metadata?.ai_video_adult_test_approved === true;
}

export async function adultVideoEntitled(db, userId, scope) {
  if (typeof userId !== 'string' || !['ai_video_create', 'ai_video_dispatch'].includes(scope)) return false;
  try {
    const { data, error } = await db.rpc('has_adult_entitlement', {
      p_user_id: userId, p_scope: scope, p_provider_route: 'wan21_t2v',
    });
    return !error && data === true;
  } catch { return false; }
}

export function normalizeDraft(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_DRAFT');
  const prompt = typeof body.prompt === 'string'
    ? body.prompt.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
  if (prompt.length < 12 || prompt.length > 600 || /[\p{Cc}\p{Cf}]/u.test(prompt)) {
    throw new Error('INVALID_PROMPT');
  }
  if (!['16:9', '9:16'].includes(body.aspect_ratio)) throw new Error('INVALID_ASPECT_RATIO');
  const style = body.style ?? 'freeform_simple';
  if (!Object.hasOwn(STYLES, style)) throw new Error('INVALID_STYLE');
  if (Object.keys(body).some(key => !['action', 'request_id', 'prompt', 'aspect_ratio',
    'style'].includes(key))) throw new Error('UNSUPPORTED_PARAMETER');
  return { prompt, aspect_ratio: body.aspect_ratio, style };
}

export async function draftHash(draft) {
  const payload = JSON.stringify({ version: 4, model: MODEL, duration: '5s',
    resolution: '480p', ...draft });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function boundedJson(response, limit = 4096) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('REQUEST_TOO_LARGE');
  }
  if (!response.body) throw new Error('EMPTY_REQUEST');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('REQUEST_TOO_LARGE');
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
  catch { throw new Error('INVALID_JSON'); }
}

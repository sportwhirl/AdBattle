import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function aiDraftKey()');
const end = html.indexOf('/* ========================================\n   POST AD', start);
const client = html.slice(start, end);
const jpeg = readFileSync(new URL('./fixtures/images/valid.jpg', import.meta.url));

test('creator previews a small JPEG before explicitly selecting it, with stable retry ID', async () => {
  const values = new Map();
  const storage = new Map();
  const invoked = [];
  const quality = [];
  const canvas = {
    width: 0, height: 0,
    getContext() { return { imageSmoothingEnabled: true, drawImage() {} }; },
    toBlob(callback, mime, factor) {
      quality.push(factor);
      callback(new Blob([jpeg], { type: mime }));
    },
  };
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('aiImagePrompt', { value: 'Two dinosaurs on Mars' });
  element('aiImageStyle', { value: 'pixel_art' });
  element('aiImageAspect', { value: '16:9' });
  element('newImage', { value: '', files: [], addEventListener() {} });
  element('aiImagePreviewImage', { removeAttribute() {} });
  const context = vm.createContext({
    currentUser: { id: 'creator-1' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true },
    generatedDraftFile: null, generatedDraftUrl: null,
    generatedDraftRequestId: null, previewDraftFile: null,
    document: { getElementById: element, createElement: name => {
      assert.equal(name, 'canvas'); return canvas;
    } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key,value) => storage.set(key,value),
      removeItem: key => storage.delete(key),
    },
    crypto: globalThis.crypto, URL, Blob, File, Response,
    createImageBitmap: async () => ({ width: 1024, height: 768, close() {} }),
    fetch: async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
    db: { functions: { async invoke(name, { body }) {
      invoked.push({ name, body });
      return { data: { request_id: body.request_id, url: 'https://private.example/draft' }, error: null };
    } } },
    functionErrorMessage: async () => 'Generation failed',
    showLogin() { throw new Error('unexpected login'); },
  });
  vm.runInContext(client, context);
  await context.generateAiDraft();
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].name, 'generate-ai-image');
  assert.equal(storage.size, 1);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 480);
  assert.deepEqual(quality, [.68]);
  assert.equal(element('aiImagePreview').hidden, false);
  assert.equal(context.generatedDraftFile, null);
  context.chooseAiDraft();
  assert.equal(context.generatedDraftFile.type, 'image/jpeg');
  assert.ok(context.generatedDraftFile.size <= 500 * 1024);
  assert.equal(context.generatedDraftRequestId, invoked[0].body.request_id);
  element('aiImagePrompt').value = 'A changed idea';
  await context.generateAiDraft();
  assert.equal(invoked.length, 1);
  assert.match(element('aiImageStatus').innerText, /previous draft/);
});

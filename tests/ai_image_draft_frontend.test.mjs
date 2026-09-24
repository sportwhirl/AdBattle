import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function aiDraftKey()');
const end = html.indexOf('/* ========================================\n   POST AD', start);
const client = html.slice(start, end);
test('creator previews the server JPEG before explicitly selecting it, with stable retry ID', async () => {
  const values = new Map();
  const storage = new Map();
  const invoked = [];
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('aiImagePrompt', { value: 'Two dinosaurs on Mars' });
  element('aiImageStyle', { value: 'pixel_art' });
  element('aiImageAspect', { value: '16:9' });
  element('newImage', { value: '', files: [], addEventListener() {} });
  element('aiImagePreviewImage', { removeAttribute() {}, async decode() {} });
  const context = vm.createContext({
    currentUser: { id: 'creator-1' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true },
    generatedDraftFile: null, generatedDraftUrl: null,
    generatedDraftRequestId: null, previewDraftFile: null,
    document: { getElementById: element, createElement() {
      throw new Error('No browser image derivative');
    } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key,value) => storage.set(key,value),
      removeItem: key => storage.delete(key),
    },
    crypto: globalThis.crypto, URL,
    fetch: async () => { throw new Error('No browser image fetch or conversion'); },
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
  assert.equal(element('aiImagePreviewImage').src, 'https://private.example/draft');
  assert.equal(element('aiImagePreview').hidden, false);
  assert.equal(context.generatedDraftFile, null);
  context.chooseAiDraft();
  assert.equal(context.generatedDraftFile, true);
  assert.equal(context.generatedDraftRequestId, invoked[0].body.request_id);
  element('aiImagePrompt').value = 'A changed idea';
  await context.generateAiDraft();
  assert.equal(invoked.length, 1);
  assert.match(element('aiImageStatus').innerText, /previous draft/);
});

test('selected AI draft posts by ID through trusted function, with no browser upload or ad INSERT', async () => {
  const start = html.indexOf('async function postAd()');
  const end = html.indexOf('/* ========================================\n   POST PAGE', start);
  const values = new Map([
    ['newTitle',{value:'A tiny world'}], ['newCaption',{value:'A friendly planet'}],
    ['newImage',{value:'',files:[]}],
  ]);
  const calls = [];
  const context = vm.createContext({
    FEATURES:{adImages:true,aiImageDrafts:true},
    currentUser:{id:'00000000-0000-4000-8000-000000000001'},
    generatedDraftFile:true,
    generatedDraftRequestId:'00000000-0000-4000-8000-000000000321',
    document:{getElementById:id=>values.get(id)},
    defaultPromotionAllocation:()=>({}),
    db:{functions:{async invoke(name, options) {
      calls.push([name,options.body]); return {data:{status:'submitted',ad_id:7},error:null};
    }},storage:{from(){throw new Error('Browser must not upload AI bytes');}},
      from(){throw new Error('Browser must not insert AI ads');}},
    discardAiDraft(){calls.push(['discard']);},
    async loadAds(){calls.push(['load']);},
    alert(message){calls.push(['alert',message]);},
    showProfile(){},profileSection(){},showLogin(){throw new Error('Unexpected login');},
  });
  vm.runInContext(html.slice(start,end),context);
  await context.postAd();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['submit-ai-ad',{
    request_id:'00000000-0000-4000-8000-000000000321',
    title:'A tiny world',caption:'A friendly planet',
  }]);
  assert.equal(values.get('newTitle').value,'');
  assert.ok(calls.some(([kind])=>kind==='discard'));
});

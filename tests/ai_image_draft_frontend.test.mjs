import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function aiDraftKey(');
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
  assert.equal(element('aiImagePrompt').value, 'Two dinosaurs on Mars');
  assert.match(element('aiImageStatus').innerText, /settings restored/i);
  assert.equal(element('discardPendingAiDraftButton').hidden, true);
});

test('recoverable generation states keep one request ID and never expose terminal reset', async () => {
  const values = new Map();
  const storage = new Map();
  const invoked = [];
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('aiImagePrompt', { value: 'A small windmill at sunrise' });
  element('aiImageStyle', { value: 'photographic' });
  element('aiImageAspect', { value: '16:9' });
  element('newImage', { value: '', files: [], addEventListener() {} });
  element('aiImagePreviewImage', { removeAttribute() {}, async decode() {} });
  const context = vm.createContext({
    currentUser: { id: 'creator-1' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true }, generatedDraftFile: null,
    generatedDraftUrl: null, generatedDraftRequestId: null, previewDraftFile: null,
    document: { getElementById: element },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000321' },
    db: { functions: { async invoke(name, { body }) {
      invoked.push({ name, body });
      const recoverable = [
        'GENERATION_IN_PROGRESS',
        'DRAFT_URL_UNAVAILABLE',
        'GENERATION_OUTCOME_UNCERTAIN',
      ];
      if (invoked.length <= recoverable.length) {
        return { data: { error: recoverable[invoked.length - 1] }, error: null };
      }
      return { data: { request_id: body.request_id, url: 'https://private.example/recovered' }, error: null };
    } } },
    functionErrorMessage: async (_error, data) => data?.error || 'Generation failed',
    showLogin() { throw new Error('unexpected login'); },
  });
  vm.runInContext(client, context);

  for (let attempt = 1; attempt <= 3; attempt++) {
    await context.generateAiDraft();
    assert.equal(invoked.length, attempt);
    assert.equal(element('discardPendingAiDraftButton').hidden, true);
    assert.equal(storage.size, 1);
  }
  assert.match(element('aiImageStatus').innerText, /same request/);
  assert.match(element('aiImageStatus').innerText, /do not discard/i);

  await context.generateAiDraft();
  assert.equal(invoked.length, 4);
  assert.ok(invoked.every(call => call.body.request_id === invoked[0].body.request_id));
  assert.equal(invoked[3].body.request_id, '00000000-0000-4000-8000-000000000321');
  assert.equal(element('aiImagePreviewImage').src, 'https://private.example/recovered');
});

test('definitive failure exposes reset, then a new request receives a new ID', async () => {
  const values = new Map();
  const storage = new Map();
  const invoked = [];
  const ids = [
    '00000000-0000-4000-8000-000000000321',
    '00000000-0000-4000-8000-000000000322',
  ];
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('aiImagePrompt', { value: 'A tiny windmill at night' });
  element('aiImageStyle', { value: 'flat_illustration' });
  element('aiImageAspect', { value: '1:1' });
  element('newImage', { value: '', files: [], addEventListener() {} });
  element('aiImagePreviewImage', { removeAttribute() {}, async decode() {} });
  const context = vm.createContext({
    currentUser: { id: 'creator-1' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true }, generatedDraftFile: null,
    generatedDraftUrl: null, generatedDraftRequestId: null, previewDraftFile: null,
    document: { getElementById: element },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    crypto: { randomUUID: () => ids.shift() },
    db: { functions: { async invoke(name, { body }) {
      invoked.push({ name, body });
      if (invoked.length === 1) {
        return { data: { error: 'GENERATION_FAILED' }, error: null };
      }
      return { data: { request_id: body.request_id, url: 'https://private.example/new-draft' }, error: null };
    } } },
    functionErrorMessage: async (_error, data) => data?.error || 'Generation failed',
    showLogin() { throw new Error('unexpected login'); },
  });
  vm.runInContext(client, context);

  await context.generateAiDraft();
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].body.request_id, '00000000-0000-4000-8000-000000000321');
  assert.equal(element('discardPendingAiDraftButton').hidden, false);
  assert.match(element('aiImageStatus').innerText, /Discard it/i);
  assert.equal(JSON.parse([...storage.values()][0]).client_state, 'discardable');

  await context.generateAiDraft();
  assert.equal(invoked.length, 1, 'terminal state must not retry the same request');

  context.discardAiDraft();
  assert.equal(storage.size, 0);
  assert.equal(element('discardPendingAiDraftButton').hidden, true);
  element('aiImagePrompt').value = 'A new windmill at sunrise';

  await context.generateAiDraft();
  assert.equal(invoked.length, 2);
  assert.equal(invoked[1].body.request_id, '00000000-0000-4000-8000-000000000322');
  assert.notEqual(invoked[0].body.request_id, invoked[1].body.request_id);
  assert.equal(element('aiImagePreviewImage').src, 'https://private.example/new-draft');
});

test('reload restores discard only for a persisted terminal draft state', () => {
  const pendingKey = 'adbattle:ai-image-draft:test-project:creator-1';
  const basePending = {
    request_id: '00000000-0000-4000-8000-000000000321',
    prompt: 'A tiny windmill at night',
    style: 'flat_illustration',
    aspect_ratio: '1:1',
  };

  for (const [clientState, expectedDiscard, statusPattern] of [
    ['discardable', true, /cannot continue.*Discard it/i],
    ['recoverable', false, /can be recovered/i],
  ]) {
    const values = new Map();
    const storage = new Map([[pendingKey, JSON.stringify({
      ...basePending,
      client_state: clientState,
    })]]);
    const element = (id, defaults = {}) => {
      if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
      return values.get(id);
    };
    element('newImage', { value: '', files: [], addEventListener() {} });
    element('aiImagePreviewImage', { removeAttribute() {} });
    const context = vm.createContext({
      currentUser: { id: 'creator-1' }, PROJECT_REF: 'test-project',
      FEATURES: { aiImageDrafts: true }, generatedDraftFile: null,
      generatedDraftUrl: null, generatedDraftRequestId: null, previewDraftFile: null,
      document: { getElementById: element },
      localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
      },
    });
    vm.runInContext(client, context);

    context.restorePendingAiDraft();

    assert.equal(element('discardPendingAiDraftButton').hidden, !expectedDiscard, clientState);
    assert.match(element('aiImageStatus').innerText, statusPattern, clientState);
    assert.equal(element('aiImagePrompt').value, basePending.prompt, clientState);
    assert.equal(element('aiImageStyle').value, basePending.style, clientState);
    assert.equal(element('aiImageAspect').value, basePending.aspect_ratio, clientState);
  }
});

test('account switch clears the old draft UI and restores only the new account record', () => {
  const values = new Map();
  let authStateChanged;
  const storage = new Map([
    ['adbattle:ai-image-draft:test-project:creator-a', JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000321',
      prompt: 'Creator A private prompt',
      style: 'pixel_art',
      aspect_ratio: '1:1',
      client_state: 'discardable',
    })],
    ['adbattle:ai-image-draft:test-project:creator-b', JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000322',
      prompt: 'Creator B private prompt',
      style: 'hand_drawn',
      aspect_ratio: '16:9',
      client_state: 'recoverable',
    })],
  ]);
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('newTitle', { value: 'Creator A private title' });
  element('newCaption', { value: 'Creator A private caption' });
  element('newImage', { value: 'creator-a-file', files: [], addEventListener() {} });
  element('profileContent', { innerHTML: '<private-card>Creator A only</private-card>' });
  element('aiImagePreviewImage', { src: 'https://private.example/a', removeAttribute(name) {
    if (name === 'src') delete this.src;
  } });
  const context = vm.createContext({
    currentUser: { id: 'creator-a' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true }, generatedDraftFile: true,
    generatedDraftUrl: 'https://private.example/a',
    generatedDraftRequestId: '00000000-0000-4000-8000-000000000321',
    previewDraftFile: true,
    walletBalanceCents: 123, walletBalance: { innerText: '$1.23' },
    walletMessage: { innerText: 'Creator A private wallet state' },
    walletTopupAmount: { value: '123.45' },
    walletTopupButton: { disabled: true, innerText: 'Opening Stripe...' },
    creatorBalanceStatus: { innerText: 'Pending creator balance: $1.00' },
    paymentStatus: { innerText: 'Creator A payments enabled' },
    setupPaymentsButton: { disabled: false, innerText: 'Payment Settings' },
    ads: [{ id: 9 }], gallery: { innerHTML: '<private-card>' },
    document: { getElementById: element },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    db: { auth: { onAuthStateChange(callback) { authStateChanged = callback; } } },
    updateAccountButton() {}, loadWalletBalance() {}, loadCreatorBalance() {}, loadAds() {},
  });
  vm.runInContext(client, context);
  const authListenerStart = html.indexOf('db.auth.onAuthStateChange(');
  const authListenerEnd = html.indexOf('/* ========================================\n   CREATE CARD', authListenerStart);
  vm.runInContext(html.slice(authListenerStart, authListenerEnd), context);

  context.restorePendingAiDraft();
  assert.equal(element('aiImagePrompt').value, 'Creator A private prompt');
  assert.equal(element('discardPendingAiDraftButton').hidden, false);

  authStateChanged('SIGNED_IN', { user: { id: 'creator-b' } });
  assert.equal(element('aiImagePrompt').value, 'Creator B private prompt');
  assert.notEqual(element('aiImagePrompt').value, 'Creator A private prompt');
  assert.equal(element('aiImageStyle').value, 'hand_drawn');
  assert.equal(element('aiImageAspect').value, '16:9');
  assert.equal(element('discardPendingAiDraftButton').hidden, true);
  assert.doesNotMatch(element('aiImageStatus').innerText, /Creator A private prompt/);
  assert.equal(element('aiImagePreview').hidden, true);
  assert.equal(element('aiImagePreviewImage').src, undefined);
  assert.equal(element('newTitle').value, '');
  assert.equal(element('newCaption').value, '');
  assert.equal(element('newImage').value, '');
  assert.equal(element('profileContent').innerHTML, '');
  assert.equal(context.walletMessage.innerText,
    'Your full top-up becomes available to support ads.');
  assert.equal(context.walletTopupAmount.value, '10.00');
  assert.equal(context.walletTopupButton.innerText, 'Add Funds');
  assert.equal(context.walletTopupButton.disabled, false);
  assert.equal(context.paymentStatus.innerText,
    'Creator onboarding is unavailable in local staging.');
  assert.equal(context.setupPaymentsButton.disabled, true);

  authStateChanged('SIGNED_OUT', null);
  assert.equal(element('aiImagePrompt').value, '');
  assert.equal(element('aiImageStyle').value, 'freeform_simple');
  assert.equal(element('aiImageAspect').value, '16:9');
  assert.equal(element('aiImageStatus').innerText, '');
  assert.equal(element('discardPendingAiDraftButton').hidden, true);
  assert.equal(storage.size, 2, 'identity reset must preserve both scoped retry records');
});

test('an in-flight generation response cannot cross an account boundary', async () => {
  const values = new Map();
  const storage = new Map([
    ['adbattle:ai-image-draft:test-project:creator-b', JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000322',
      prompt: 'Creator B saved prompt',
      style: 'hand_drawn',
      aspect_ratio: '1:1',
      client_state: 'recoverable',
    })],
  ]);
  let resolveInvoke;
  const invokeResult = new Promise(resolve => { resolveInvoke = resolve; });
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('aiImagePrompt', { value: 'Creator A private prompt' });
  element('aiImageStyle', { value: 'pixel_art' });
  element('aiImageAspect', { value: '16:9' });
  element('newImage', { value: '', files: [], addEventListener() {} });
  element('aiImagePreviewImage', { removeAttribute(name) {
    if (name === 'src') delete this.src;
  }, async decode() {} });
  const context = vm.createContext({
    currentUser: { id: 'creator-a' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true }, generatedDraftFile: null,
    generatedDraftUrl: null, generatedDraftRequestId: null, previewDraftFile: null,
    walletBalanceCents: 123, walletBalance: { innerText: '$1.23' },
    walletMessage: { innerText: 'Creator A private wallet state' },
    walletTopupAmount: { value: '123.45' },
    walletTopupButton: { disabled: true, innerText: 'Opening Stripe...' },
    creatorBalanceStatus: { innerText: 'Pending creator balance: $1.00' },
    paymentStatus: { innerText: 'Creator A payments enabled' },
    setupPaymentsButton: { disabled: false, innerText: 'Payment Settings' },
    ads: [{ id: 9 }], gallery: { innerHTML: '<private-card>' },
    document: { getElementById: element },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000321' },
    db: { functions: { invoke: () => invokeResult } },
    functionErrorMessage: async () => 'unexpected error',
    showLogin() { throw new Error('unexpected login'); },
  });
  vm.runInContext(client, context);

  const pendingGeneration = context.generateAiDraft();
  const creatorAKey = 'adbattle:ai-image-draft:test-project:creator-a';
  assert.equal(JSON.parse(storage.get(creatorAKey)).client_state, 'recoverable');

  context.currentUser = { id: 'creator-b' };
  context.resetAiDraftUiForIdentityChange();
  context.restorePendingAiDraft();
  const creatorBKey = 'adbattle:ai-image-draft:test-project:creator-b';
  const creatorBStored = storage.get(creatorBKey);
  const creatorBStatus = element('aiImageStatus').innerText;
  element('generateAiImageButton').disabled = true;

  resolveInvoke({ data: {
    request_id: '00000000-0000-4000-8000-000000000321',
    url: 'https://private.example/creator-a-only',
  }, error: null });
  await pendingGeneration;

  assert.equal(element('aiImagePrompt').value, 'Creator B saved prompt');
  assert.equal(element('aiImageStatus').innerText, creatorBStatus);
  assert.equal(element('aiImagePreviewImage').src, undefined);
  assert.equal(context.generatedDraftRequestId, null);
  assert.equal(context.generatedDraftUrl, null);
  assert.equal(storage.get(creatorBKey), creatorBStored);
  assert.equal(JSON.parse(storage.get(creatorAKey)).client_state, 'recoverable');
  assert.equal(element('generateAiImageButton').disabled, true,
    'the stale finally block must not re-enable another account operation');
});

test('an account switch during private image decode keeps the new UI clean', async () => {
  const values = new Map();
  const storage = new Map();
  let resolveDecode;
  let signalDecodeStarted;
  const decodeStarted = new Promise(resolve => { signalDecodeStarted = resolve; });
  const decodeResult = new Promise(resolve => { resolveDecode = resolve; });
  const element = (id, defaults = {}) => {
    if (!values.has(id)) values.set(id, { hidden: true, innerText: '', value: '', ...defaults });
    return values.get(id);
  };
  element('aiImagePrompt', { value: 'Creator A private prompt' });
  element('aiImageStyle', { value: 'pixel_art' });
  element('aiImageAspect', { value: '16:9' });
  element('newImage', { value: '', files: [], addEventListener() {} });
  element('aiImagePreviewImage', { removeAttribute(name) {
    if (name === 'src') delete this.src;
  }, decode() { signalDecodeStarted(); return decodeResult; } });
  const context = vm.createContext({
    currentUser: { id: 'creator-a' }, PROJECT_REF: 'test-project',
    FEATURES: { aiImageDrafts: true }, generatedDraftFile: null,
    generatedDraftUrl: null, generatedDraftRequestId: null, previewDraftFile: null,
    walletBalanceCents: 123, walletBalance: { innerText: '$1.23' },
    walletMessage: { innerText: 'Creator A private wallet state' },
    walletTopupAmount: { value: '123.45' },
    walletTopupButton: { disabled: true, innerText: 'Opening Stripe...' },
    creatorBalanceStatus: { innerText: 'Pending creator balance: $1.00' },
    paymentStatus: { innerText: 'Creator A payments enabled' },
    setupPaymentsButton: { disabled: false, innerText: 'Payment Settings' },
    ads: [{ id: 9 }], gallery: { innerHTML: '<private-card>' },
    document: { getElementById: element },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000321' },
    db: { functions: { async invoke() { return { data: {
      request_id: '00000000-0000-4000-8000-000000000321',
      url: 'https://private.example/creator-a-only',
    }, error: null }; } } },
    functionErrorMessage: async () => 'unexpected error',
    showLogin() { throw new Error('unexpected login'); },
  });
  vm.runInContext(client, context);

  const pendingGeneration = context.generateAiDraft();
  await decodeStarted;
  context.currentUser = { id: 'creator-b' };
  context.resetAiDraftUiForIdentityChange();
  element('aiImagePrompt').value = 'Creator B new prompt';
  element('aiImageStatus').innerText = 'Creator B status';
  resolveDecode();
  await pendingGeneration;

  assert.equal(element('aiImagePrompt').value, 'Creator B new prompt');
  assert.equal(element('aiImageStatus').innerText, 'Creator B status');
  assert.equal(element('aiImagePreviewImage').src, undefined);
  assert.equal(context.generatedDraftRequestId, null);
  assert.equal(context.generatedDraftUrl, null);
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
    aiDraftUiEpoch:0,
    aiDraftUiIsCurrent:(userId,epoch) =>
      userId === '00000000-0000-4000-8000-000000000001' && epoch === 0,
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

test('an in-flight AI submission cannot clear or update the next account composer', async () => {
  const start = html.indexOf('async function postAd()');
  const end = html.indexOf('/* ========================================\n   POST PAGE', start);
  const values = new Map([
    ['newTitle', { value: 'Creator A title' }],
    ['newCaption', { value: 'Creator A caption' }],
    ['newImage', { value: '', files: [] }],
  ]);
  const calls = [];
  let resolveSubmit;
  const submitResult = new Promise(resolve => { resolveSubmit = resolve; });
  const context = vm.createContext({
    FEATURES: { adImages: true, aiImageDrafts: true },
    currentUser: { id: 'creator-a' },
    aiDraftUiEpoch: 0,
    generatedDraftFile: true,
    generatedDraftRequestId: '00000000-0000-4000-8000-000000000321',
    document: { getElementById: id => values.get(id) },
    defaultPromotionAllocation: () => ({}),
    db: {
      functions: { invoke: () => submitResult },
      storage: { from() { throw new Error('Browser must not upload AI bytes'); } },
      from() { throw new Error('Browser must not insert AI ads'); },
    },
    functionErrorMessage: async () => 'unexpected error',
    discardAiDraft() { calls.push('discard'); },
    async loadAds() { calls.push('load'); },
    alert(message) { calls.push(['alert', message]); },
    showProfile() { calls.push('profile'); },
    profileSection() { calls.push('section'); },
    showLogin() { throw new Error('unexpected login'); },
  });
  context.aiDraftUiIsCurrent = (userId, epoch) =>
    context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
  vm.runInContext(html.slice(start, end), context);

  const pendingSubmission = context.postAd();
  context.currentUser = { id: 'creator-b' };
  context.aiDraftUiEpoch += 1;
  values.get('newTitle').value = 'Creator B title';
  values.get('newCaption').value = 'Creator B caption';
  resolveSubmit({ data: { status: 'submitted', ad_id: 7 }, error: null });
  await pendingSubmission;

  assert.equal(values.get('newTitle').value, 'Creator B title');
  assert.equal(values.get('newCaption').value, 'Creator B caption');
  assert.deepEqual(calls, []);
});

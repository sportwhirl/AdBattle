import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return html.slice(start, end);
}

test('identity reset clears shared profile, payment, wallet, top-up, Support, and return-message state', () => {
  const elements = new Map();
  const element = (id, defaults = {}) => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: false,
        disabled: true,
        innerHTML: '<old-account-data>',
        innerText: 'old-account-data',
        value: 'old-account-data',
        ...defaults,
      });
    }
    return elements.get(id);
  };
  const previewImage = element('aiImagePreviewImage', {
    src: 'https://private.example/creator-a',
    removeAttribute(name) {
      if (name === 'src') delete this.src;
    },
  });
  const supportBox = { removed: false, remove() { this.removed = true; } };
  const returnMessage = { removed: false, remove() { this.removed = true; } };
  const walletBalance = { innerText: '$7.89' };
  const walletMessage = { innerText: 'Creator A wallet message' };
  const walletTopupAmount = { value: '75.00' };
  const walletTopupButton = { disabled: true, innerText: 'Opening Stripe...' };
  const creatorBalanceStatus = { innerText: 'Pending creator balance: $4.56' };
  const paymentStatus = { innerText: 'Creator A payments enabled' };
  const setupPaymentsButton = { disabled: false, innerText: 'Creator A payments' };
  const gallery = { innerHTML: '<article>Creator A private card</article>' };
  const context = vm.createContext({
    currentUser: { id: 'creator-a' },
    PROJECT_REF: 'project-1',
    FEATURES: { aiImageDrafts: true, creatorOnboarding: true },
    generatedDraftFile: true,
    generatedDraftUrl: 'https://private.example/creator-a',
    generatedDraftRequestId: '10000000-0000-4000-8000-000000000001',
    previewDraftFile: true,
    walletBalanceCents: 789,
    walletBalance,
    walletMessage,
    walletTopupAmount,
    walletTopupButton,
    creatorBalanceStatus,
    paymentStatus,
    setupPaymentsButton,
    ads: [{ id: 1, owner: true }],
    gallery,
    document: {
      getElementById: element,
      querySelectorAll(selector) {
        assert.equal(selector, '.support-box, .return-message');
        return [supportBox, returnMessage];
      },
    },
  });
  vm.runInContext(sliceBetween(
    'function aiDraftKey(',
    'function discardAiDraft()',
  ), context);

  context.resetAiDraftUiForIdentityChange();

  assert.equal(element('profileContent').innerHTML, '');
  assert.equal(walletBalance.innerText, '$0.00');
  assert.equal(walletMessage.innerText, 'Your full top-up becomes available to support ads.');
  assert.equal(walletTopupAmount.value, '10.00');
  assert.deepEqual(walletTopupButton, { disabled: false, innerText: 'Add Funds' });
  assert.equal(creatorBalanceStatus.innerText, 'Pending creator balance: $0.00');
  assert.equal(paymentStatus.innerText, 'Checking payment setup...');
  assert.deepEqual(setupPaymentsButton, { disabled: true, innerText: 'Set Up Payments' });
  assert.equal(supportBox.removed, true);
  assert.equal(returnMessage.removed, true);
  assert.equal(gallery.innerHTML, '');
  assert.equal(element('aiImagePreview').hidden, true);
  assert.equal(previewImage.src, undefined);
  assert.equal(element('newTitle').value, '');
  assert.equal(element('newCaption').value, '');
  assert.equal(element('newImage').value, '');
  assert.equal(element('creatorHandle').value, '');
  assert.equal(context.walletBalanceCents, 0);
  assert.equal(context.ads.length, 0);
});

test('an in-flight Seed response cannot mutate the next account UI', async () => {
  let resolveResponse;
  let markStarted;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const calls = [];
  const walletBalance = { innerText: '$1.00' };
  const seedButton = { disabled: false, innerText: 'Seed · 1¢' };
  const context = vm.createContext({
    FEATURES: { seeds: true },
    currentUser: { id: 'creator-a' },
    aiDraftUiEpoch: 0,
    walletBalanceCents: 100,
    walletBalance,
    ads: [{ id: 41, moderationStatus: 'approved', owner: false, seeded: false }],
    aiDraftUiIsCurrent(userId, epoch) {
      return context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
    },
    async loadWalletBalance() {},
    readPendingSupport() { return null; },
    submitWalletSupport(adId, amountCents, action) {
      calls.push(['submit', adId, amountCents, action]);
      markStarted();
      return response;
    },
    async loadAds() { calls.push(['loadAds']); },
    async loadCreatorBalance() { calls.push(['loadCreatorBalance']); },
    refreshCurrentView() { calls.push(['refresh']); },
    showReturnMessage(message) { calls.push(['return', message]); },
    showLogin() { calls.push(['login']); },
    alert(message) { calls.push(['alert', message]); },
    console: { error() {} },
    formatCents(cents) { return `$${(cents / 100).toFixed(2)}`; },
  });
  vm.runInContext(sliceBetween(
    'async function seedAd(',
    '/* ========================================\n   SUPPORT',
  ), context);

  const pendingSeed = context.seedAd(41, seedButton);
  await started;
  context.currentUser = { id: 'creator-b' };
  context.aiDraftUiEpoch += 1;
  context.walletBalanceCents = 777;
  walletBalance.innerText = '$7.77';
  resolveResponse({ balance_cents: 99, already_seeded: false });
  await pendingSeed;

  assert.deepEqual(calls, [['submit', 41, 1, 'seed']]);
  assert.equal(context.walletBalanceCents, 777);
  assert.equal(walletBalance.innerText, '$7.77');
});

test('an in-flight top-up response cannot persist a session or navigate under the next account', async () => {
  const storage = new Map();
  const writes = [];
  let resolveResponse;
  let markStarted;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const walletTopupAmount = { value: '10.00', focus() {} };
  const walletTopupButton = { disabled: false, innerText: 'Add Funds' };
  const walletMessage = { innerText: '' };
  const window = { location: { href: 'https://adbattle.example/profile' } };
  const context = vm.createContext({
    currentUser: { id: 'creator-a' },
    PROJECT_REF: 'project-1',
    aiDraftUiEpoch: 0,
    aiDraftUiIsCurrent(userId, epoch) {
      return context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        writes.push([key, value]);
        storage.set(key, value);
      },
      removeItem: key => storage.delete(key),
    },
    crypto: { randomUUID: () => '20000000-0000-4000-8000-000000000001' },
    URL,
    URLSearchParams,
    Date,
    window,
    walletTopupAmount,
    walletTopupButton,
    walletMessage,
    db: {
      functions: {
        invoke(name, { body }) {
          assert.equal(name, 'create-wallet-checkout');
          assert.equal(body.amount_cents, 1000);
          markStarted();
          return response;
        },
      },
      from() { throw new Error('wallet reconciliation is not expected'); },
    },
    inputDollarsToCents(value) { return Math.round(Number(value) * 100); },
    formatCents(cents) { return `$${(cents / 100).toFixed(2)}`; },
    functionErrorMessage: async (_error, data, fallback) => data?.error || fallback,
    showReturnMessage() {},
    showLogin() { throw new Error('unexpected login'); },
    console: { error() {} },
  });
  vm.runInContext(sliceBetween(
    'function pendingTopupKey()',
    '/* ========================================\n   AUTH',
  ), context);

  const pendingTopup = context.addWalletFunds();
  await started;
  const creatorAKey = 'adbattle:pending-topup:project-1:creator-a';
  assert.equal(storage.has(creatorAKey), true);

  context.currentUser = { id: 'creator-b' };
  context.aiDraftUiEpoch += 1;
  walletTopupAmount.value = '25.00';
  walletTopupButton.disabled = false;
  walletTopupButton.innerText = 'Add Funds';
  walletMessage.innerText = 'Creator B wallet';
  resolveResponse({
    data: { url: 'https://checkout.stripe.com/c/pay/cs_test_CREATORA1' },
    error: null,
  });
  await pendingTopup;

  assert.equal(writes.length, 1, 'only the pre-request Creator A retry record is saved');
  assert.equal(JSON.parse(storage.get(creatorAKey)).checkout_session_id, undefined);
  assert.equal(storage.has('adbattle:pending-topup:project-1:creator-b'), false);
  assert.equal(window.location.href, 'https://adbattle.example/profile');
  assert.equal(walletTopupAmount.value, '25.00');
  assert.deepEqual(walletTopupButton, { disabled: false, innerText: 'Add Funds' });
  assert.equal(walletMessage.innerText, 'Creator B wallet');
});

function supportBoxHarness() {
  const picker = { hidden: false };
  const slider = {
    value: '0',
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    focus() {},
  };
  const selection = { textContent: '' };
  const customEntry = { hidden: true };
  const customInput = {
    value: '',
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    focus() {},
  };
  const pickerMessage = {
    textContent: '',
    classList: { toggle() {} },
  };
  const confirm = {
    disabled: false,
    innerText: '',
    focus() {},
    async click() { return this.onclick?.(); },
  };
  const cancel = {};
  const selectorMap = new Map([
    ['.support-picker', picker],
    ['.support-range', slider],
    ['output', selection],
    ['.custom-support-entry', customEntry],
    ['.custom-support-input', customInput],
    ['.support-picker-message', pickerMessage],
    ['.confirm-support', confirm],
    ['.cancel-support', cancel],
  ]);
  const box = {
    removed: false,
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    querySelector(selector) { return selectorMap.get(selector); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    remove() { this.removed = true; },
  };
  return { box, confirm };
}

test('an open Support confirmation remains bound to the identity that opened it', async () => {
  const created = supportBoxHarness();
  const calls = [];
  let appended;
  const supportButton = {
    focus() {},
    closest(selector) {
      assert.equal(selector, '.caption');
      return { appendChild(box) { appended = box; } };
    },
  };
  const presets = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181];
  const context = vm.createContext({
    currentUser: { id: 'creator-a' },
    aiDraftUiEpoch: 0,
    walletBalanceCents: 1000,
    ads: [{ id: 91, moderationStatus: 'approved' }],
    SUPPORT_CUSTOM_INDEX: presets.length,
    CUSTOM_SUPPORT_MINIMUM_CENTS: 5000,
    aiDraftUiIsCurrent(userId, epoch) {
      return context.currentUser?.id === userId && context.aiDraftUiEpoch === epoch;
    },
    async loadWalletBalance() {},
    readPendingSupport() { return null; },
    pendingSupportAction(pending) { return pending?.action === 'seed' ? 'seed' : 'support'; },
    supportPresetCents(index) { return presets[Number(index)] ?? null; },
    inputDollarsToCents(value) {
      const amount = Number(value);
      return Number.isFinite(amount) ? Math.round(amount * 100) : null;
    },
    formatCents(cents) { return `$${(cents / 100).toFixed(2)}`; },
    async submitWalletSupport(...args) { calls.push(['submit', ...args]); return { balance_cents: 999 }; },
    async loadAds() { calls.push(['loadAds']); },
    async loadCreatorBalance() { calls.push(['loadCreatorBalance']); },
    refreshCurrentView() { calls.push(['refresh']); },
    showReturnMessage(message) { calls.push(['return', message]); },
    showLogin() { calls.push(['login']); },
    alert(message) { calls.push(['alert', message]); },
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '.support-box');
        return [];
      },
      createElement(tagName) {
        assert.equal(tagName, 'div');
        return created.box;
      },
      getElementById() { return { innerText: '' }; },
    },
    console: { error() {} },
  });
  vm.runInContext(sliceBetween(
    'async function openSupport(',
    '/* ========================================\n   STAGING AI IMAGE DRAFT',
  ), context);

  await context.openSupport(91, supportButton);
  assert.equal(appended, created.box);
  assert.equal(created.confirm.disabled, false);
  assert.equal(created.confirm.innerText, 'Support $0.01');

  context.currentUser = { id: 'creator-b' };
  context.aiDraftUiEpoch += 1;
  await created.confirm.click();

  assert.deepEqual(calls, [], 'the stale Creator A confirmation must send no wallet action');
});

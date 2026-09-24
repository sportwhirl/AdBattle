import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helper = html.slice(html.indexOf('function pendingSupportKey()'),html.indexOf('function formatMicros('));
function client(storage, invoke) {
  const ctx = vm.createContext({
    currentUser:{id:'user-1'}, PROJECT_REF:'project-1', localStorage:{
      getItem:k=>storage.get(k) ?? null,
      setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k),
    }, crypto:globalThis.crypto, db:{functions:{invoke}},
    formatCents:c=>`$${(c/100).toFixed(2)}`,
    functionErrorMessage:async(e,d,f)=>d?.error || e?.message || f,
  });
  vm.runInContext(helper,ctx);
  return ctx;
}
test('actual client retries a lost response after reload without a second debit', async () => {
  const storage = new Map();
  const ledger = new Map();
  let balance = 1000;
  let calls=0;
  const invoke = async (_,{body})=>{
    calls++;
    if (!ledger.has(body.request_id)) {
      balance-=body.amount_cents;
      ledger.set(body.request_id,{ok:true,balance_cents:balance});
    }
    if(calls===1) return {error:new Error('Lost response AFTER commit')};
    return {data:ledger.get(body.request_id)};
  };
  await assert.rejects(client(storage,invoke).submitWalletSupport(1,100),/Lost response/);
  assert.ok(storage.has('adbattle:pending-support:project-1:user-1'));
  await client(storage,invoke).submitWalletSupport(1,100);
  assert.equal(balance,900);
  assert.equal(ledger.size,1);
  assert.equal(storage.size,0);
});
test('unresolved Support cannot be retried with a changed ad or amount', async () => {
  const storage=new Map(); let calls=0;
  const ctx=client(storage,async()=>{calls++;return {error:new Error('offline')};});
  await assert.rejects(ctx.submitWalletSupport(1,100));
  await assert.rejects(ctx.submitWalletSupport(1,200),/Resolve your pending/);
  await assert.rejects(ctx.submitWalletSupport(2,100),/Resolve your pending/);
  assert.equal(calls,1);
});
test('pending request identity is isolated between Seed and Support', async () => {
  for (const [firstAction, secondAction, amount] of [
    ['support', 'seed', 1],
    ['seed', 'support', 1],
  ]) {
    const storage = new Map(); let calls = 0;
    const ctx = client(storage, async () => {
      calls++;
      return { error: new Error('offline') };
    });
    await assert.rejects(ctx.submitWalletSupport(1, amount, firstAction));
    await assert.rejects(
      ctx.submitWalletSupport(1, amount, secondAction),
      /pending .* (Seed|Support)/,
    );
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse([...storage.values()][0]).action,
      firstAction,
    );
  }
});
test('legacy pending requests remain ordinary Support and exact Seed retries reuse action and UUID', async () => {
  const key = 'adbattle:pending-support:project-1:user-1';
  const legacyStorage = new Map([[key, JSON.stringify({
    ad_id: 1, amount_cents: 1,
    request_id: '10000000-0000-4000-8000-000000000001',
  })]]);
  const sent = [];
  await client(legacyStorage, async (_name, { body }) => {
    sent.push(body);
    return { data: { ok: true } };
  }).submitWalletSupport(1, 1, 'support');
  assert.equal(sent[0].action, undefined);
  assert.equal(legacyStorage.size, 0);

  const seedStorage = new Map();
  const requestIds = [];
  let calls = 0;
  const invoke = async (_name, { body }) => {
    calls++;
    requestIds.push(body.request_id);
    assert.equal(body.action, 'seed');
    if (calls === 1) return { error: new Error('lost Seed response') };
    return { data: { ok: true, balance_cents: 999 } };
  };
  await assert.rejects(
    client(seedStorage, invoke).submitWalletSupport(2, 1, 'seed'),
    /lost Seed response/,
  );
  await client(seedStorage, invoke).submitWalletSupport(2, 1, 'seed');
  assert.equal(new Set(requestIds).size, 1);
  assert.equal(seedStorage.size, 0);
});
test('authoritative Seed state clears only the matching uncertain Seed request', () => {
  const key = 'adbattle:pending-support:project-1:user-1';
  const pending = {
    ad_id: 3,
    amount_cents: 1,
    request_id: '10000000-0000-4000-8000-000000000001',
    action: 'seed',
  };
  const storage = new Map([[key, JSON.stringify(pending)]]);
  const ctx = client(storage, async () => {
    throw new Error('not used');
  });
  ctx.reconcileRecordedSeedPending(new Set([2]));
  assert.equal(storage.size, 1);
  ctx.reconcileRecordedSeedPending(new Set([3]));
  assert.equal(storage.size, 0);

  pending.action = 'support';
  storage.set(key, JSON.stringify(pending));
  ctx.reconcileRecordedSeedPending(new Set([3]));
  assert.equal(storage.size, 1);
});
test('storage failure prevents a debit rather than losing its retry identity', async () => {
  let calls=0;
  const ctx=client(new Map(),async()=>{calls++;return {data:{ok:true}};});
  ctx.localStorage.setItem=()=>{throw new Error('Storage unavailable');};
  await assert.rejects(ctx.submitWalletSupport(1,1,'seed'),/Storage unavailable/);
  assert.equal(calls,0);
});

const workerTs = readFileSync(new URL('../supabase/functions/settle-wallet-support/index.ts',import.meta.url),'utf8');
const workerJs=stripTypeScriptTypes(workerTs.replace(/^import .*;\n/m,''));
function worker({guard, fetchImpl, completeError=null, secret='sk_test_fake'}) {
  const rpcCalls=[];
  const ctx=vm.createContext({
    Deno:{env:{get:k=>({STRIPE_SECRET_KEY:secret,SUPABASE_URL:'https://example.test',
      SUPABASE_SERVICE_ROLE_KEY:'test',SETTLEMENT_CRON_SECRET:'test'})[k]},serve(){}},
    createClient:()=>({rpc:async(name,args)=>{
      rpcCalls.push({name,args});
      if(name==='prepare_wallet_transfer') return {data:guard};
      if(name==='complete_wallet_settlement') return {error:completeError};
      return {};
    }}),
    fetch:fetchImpl,URLSearchParams,AbortSignal,Date,console,
  });
  vm.runInContext(workerJs,ctx);
  return {ctx,rpcCalls};
}
const settlement={settlement_id:'settlement-1',ad_id:1,creator_user_id:'creator',
  stripe_account_id:'acct_mutable',creator_transfer_cents:900,trigger_reason:'threshold'};
test('actual worker makes no Stripe request for an expired or manual-review transfer',async()=>{
  for(const guard of [
    {allowed:false,reason:'manual_review'},
    {allowed:true,destination:'acct_fixed',retry_before:new Date(Date.now()-1000).toISOString()},
    {allowed:false,reason:'payment_risk_hold'},
  ]) {
    let calls=0;
    const {ctx}=worker({guard,fetchImpl:async()=>{calls++;}});
    assert.equal((await ctx.transferSettlement(settlement)).status,'held');
    assert.equal(calls,0);
  }
});
test('worker uses the frozen destination and same idempotency key after ledger failure',async()=>{
  const requests=[];
  const {ctx}=worker({
    guard:{allowed:true,destination:'acct_fixed',retry_before:new Date(Date.now()+3600000).toISOString()},
    fetchImpl:async(_,opts)=>{requests.push(opts);return {ok:true,json:async()=>({id:'tr_once'})};},
    completeError:{message:'database unavailable'},
  });
  await assert.rejects(ctx.transferSettlement(settlement),/ledger completion failed/);
  await assert.rejects(ctx.transferSettlement(settlement),/ledger completion failed/);
  assert.equal(new URLSearchParams(requests[0].body).get('destination'),'acct_fixed');
  assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);
  assert.equal(requests[0].body,requests[1].body);
});
test('worker refuses live-mode transfers',async()=>{
  let calls=0;
  const {ctx}=worker({guard:{allowed:true},secret:'sk_live_fake',fetchImpl:async()=>{calls++;}});
  await assert.rejects(ctx.transferSettlement(settlement),/restricted to Stripe test mode/);
  assert.equal(calls,0);
});

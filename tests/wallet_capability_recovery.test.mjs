import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/settle-wallet-support/index.ts',import.meta.url),'utf8');
const js = stripTypeScriptTypes(source.replace(/^import .*;\n/m,''));
const id = '10000000-0000-4000-8000-000000000099';
const key = `adbattle-settlement-${id}`;
const row = {id,settlement_id:id,ad_id:1,creator_user_id:'creator',creator_transfer_cents:900,
  status:'retry',trigger_reason:'threshold'};
const rejection = (status=400,code='insufficient_capabilities_for_transfer',replayed='true',requestId='req_verified') =>
  Response.json({error:{code,message:'capability rejected'}},{status,headers:{
    ...(replayed ? {'Idempotent-Replayed':replayed} : {}),
    ...(requestId ? {'Request-Id':requestId} : {}),
  }});

function worker({fetchImpl=async()=>rejection(),guardPatch={},secret='sk_test_fake',
  loseAuthorization=false,completeError=null,status='retry',creatorReady=true}={}) {
  let handler; let recoveryKey; const calls=[]; const requests=[];
  const guard = () => ({allowed:true,destination:'acct_fixed',
    retry_before:new Date(Date.now()+3600000).toISOString(),idempotency_key:recoveryKey || key,...guardPatch});
  const ctx = vm.createContext({Deno:{env:{get:k=>({SUPABASE_URL:'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY:'test',STRIPE_SECRET_KEY:secret,SETTLEMENT_CRON_SECRET:'test'})[k]},serve:f=>{handler=f;}},
    createClient:()=>({
      from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==='creator_accounts'
        ? {stripe_account_id:'acct_mutable',onboarding_complete:creatorReady,
          charges_enabled:creatorReady,payouts_enabled:creatorReady} : {...row,status}})})})}),
      rpc:async(name,args)=>{
        calls.push({name,args});
        if(name==='prepare_wallet_transfer') return {data:guard()};
        if(name==='authorize_wallet_capability_recovery') {
          recoveryKey ||= key+'-capability-recovery-1';
          return loseAuthorization ? {error:{message:'lost reply after commit'}} : {data:{idempotency_key:recoveryKey}};
        }
        if(name==='complete_wallet_settlement') return {error:completeError};
        if(name==='claim_due_wallet_settlements') return {data:[]};
        return {};
      },
    }),
    fetch:async(url,options)=>{requests.push({url,options});return fetchImpl(url,options);},
    Response,Request,URLSearchParams,AbortSignal,Date,console,
  });
  vm.runInContext(js,ctx);
  return {ctx,calls,requests,send:(body,headers={'x-adbattle-settlement-secret':'test'})=>handler(
    new Request('https://example.test/settle',{method:'POST',headers,body}))};
}

test('verified cached capability rejection persists one key without sending a replacement transfer',async()=>{
  const w=worker();
  assert.equal((await w.ctx.recoverCapabilityFailure(id)).status,'recovery_authorized');
  assert.equal(w.requests.length,1);
  assert.equal(w.requests[0].options.headers['Idempotency-Key'],key);
  const p=new URLSearchParams(w.requests[0].options.body);
  assert.equal(p.get('amount'),'900'); assert.equal(p.get('destination'),'acct_fixed');
  assert.equal(p.get('metadata[settlement_id]'),id);
  assert.equal(w.calls.filter(c=>c.name==='authorize_wallet_capability_recovery').length,1);
  assert.equal((await w.ctx.recoverCapabilityFailure(id)).status,'recovery_already_authorized');
  assert.equal(w.requests.length,1);
});

test('unknown, uncached, other-code, malformed and server failures cannot authorize replacement',async()=>{
  for (const fetchImpl of [
    async()=>rejection(400,'insufficient_capabilities_for_transfer',null),
    async()=>rejection(400,'insufficient_capabilities_for_transfer','true',null),
    async()=>rejection(400,'invalid_request_error'),
    async()=>rejection(409), async()=>rejection(429), async()=>rejection(500),
    async()=>{throw new Error('timeout');},
    async()=>new Response('not json',{status:400}),
  ]) {
    const w=worker({fetchImpl});
    try { assert.equal((await w.ctx.recoverCapabilityFailure(id)).status,'held'); } catch (e) {
      assert.match(e.message,/timeout|JSON|Unexpected/);
    }
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_capability_recovery'),false);
  }
});

test('original-key success reconciles once; a ledger failure cannot authorize another key',async()=>{
  for(const completeError of [null,{message:'offline'}]) {
    const w=worker({fetchImpl:async()=>Response.json({id:'tr_original'}),completeError});
    if(completeError) await assert.rejects(w.ctx.recoverCapabilityFailure(id),/keep original key/);
    else assert.equal((await w.ctx.recoverCapabilityFailure(id)).transfer_id,'tr_original');
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_capability_recovery'),false);
  }
});

test('lost authorization reply and later transfer retries retain the persisted replacement key',async()=>{
  let transferred=0; const receipts=new Map();
  const w=worker({loseAuthorization:true,completeError:{message:'lost ledger completion'},fetchImpl:async(_,opts)=>{
    const k=opts.headers['Idempotency-Key'];
    if(k===key) return rejection();
    if(!receipts.has(k)) {transferred++;receipts.set(k,'tr_only_once');}
    return Response.json({id:receipts.get(k)});
  }});
  await assert.rejects(w.ctx.recoverCapabilityFailure(id),/not confirmed/);
  assert.equal((await w.ctx.recoverCapabilityFailure(id)).status,'recovery_already_authorized');
  for(let i=0;i<2;i++) await assert.rejects(w.ctx.transferSettlement(row),/ledger completion failed/);
  assert.equal(transferred,1);
  assert.equal(w.requests[1].options.headers['Idempotency-Key'],key+'-capability-recovery-1');
  assert.equal(w.requests[1].options.body,w.requests[2].options.body);
});

test('live keys, holds, deadlines and completed settlements cannot start recovery verification',async()=>{
  for(const options of [
    {secret:'sk_live_fake'}, {guardPatch:{allowed:false,reason:'manual_review'}},
    {guardPatch:{allowed:false,reason:'payment_risk_hold'}},
    {guardPatch:{retry_before:new Date(Date.now()-1000).toISOString()}},
    {guardPatch:{retry_before:'invalid'}}, {status:'succeeded'}, {creatorReady:false},
  ]) {
    const w=worker(options);
    try { assert.equal((await w.ctx.recoverCapabilityFailure(id)).status,'held'); } catch(e) {
      assert.match(e.message,/restricted to Stripe test mode/);
    }
    assert.equal(w.requests.length,0);
  }
});

test('recovery remains secret-authenticated, strictly validated and separate from normal claiming',async()=>{
  const w=worker();
  const body=JSON.stringify({recover_capability_failure:id});
  assert.equal((await w.send(body,{})).status,401);
  for(const value of ['null','[]','bad json','{"recover_capability_failure":"bad"}',
    JSON.stringify({recover_capability_failure:id,amount:1000})]) assert.equal((await w.send(value)).status,400);
  assert.equal(w.calls.length,0);
  assert.equal((await (await w.send(body)).json()).recovery.status,'recovery_authorized');
  assert.equal(w.calls.some(c=>c.name==='claim_due_wallet_settlements'),false);
  assert.equal((await (await w.send('{}')).json()).processed,0);
  assert.equal((await (await w.send('')).json()).processed,0);
});

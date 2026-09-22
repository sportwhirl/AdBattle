import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../supabase/functions/settle-wallet-support/index.ts',import.meta.url),'utf8');
const js=stripTypeScriptTypes(source.replace(/^import .*;\n/m,''));
const id='10000000-0000-4000-8000-000000000088';
const baseKey=`adbattle-settlement-${id}`;
const failedKey=baseKey+'-capability-recovery-1';
const newKey=baseKey+'-balance-recovery-1';
const row={id,settlement_id:id,ad_id:1,creator_user_id:'creator',creator_transfer_cents:900,
  status:'retry',trigger_reason:'threshold'};
const transfer={id:'tr_existing',object:'transfer',amount:900,currency:'usd',
  destination:'acct_fixed',metadata:{settlement_id:id}};
const balance=(amount=1912,patch={},headers={'Request-Id':'req_balance'})=>Response.json({
  object:'balance',livemode:false,available:[{currency:'usd',amount,source_types:{card:amount}}],...patch,
},{headers});
const rejection=(status=400,patch={},headers={'Request-Id':'req_rejected','Idempotent-Replayed':'true'})=>
  Response.json({error:{code:'balance_insufficient',type:'invalid_request_error',...patch}},{status,headers});

function worker({getBalance=async()=>balance(),postTransfer=async()=>rejection(),guardPatch={},
  secret='sk_test_fake',currentDestination='acct_fixed',creatorReady=true,status='retry',
  loseAuthorization=false,completeError=null}={}) {
  let handler; let recoveryKey; let now=Date.now(); const requests=[]; const calls=[];
  const deadline=new Date(now+3600000).toISOString();
  class ClockDate extends Date { static now() { return now; } }
  const ctx=vm.createContext({
    Deno:{env:{get:k=>({STRIPE_SECRET_KEY:secret,SUPABASE_URL:'https://example.test',
      SUPABASE_SERVICE_ROLE_KEY:'test',SETTLEMENT_CRON_SECRET:'test'})[k]},serve:f=>{handler=f;}},
    createClient:()=>({
      from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==='creator_accounts'
        ? {stripe_account_id:currentDestination,onboarding_complete:creatorReady,
          charges_enabled:creatorReady,payouts_enabled:creatorReady} : {...row,status}})})})}),
      rpc:async(name,args)=>{
        calls.push({name,args});
        if(name==='prepare_wallet_transfer') return {data:{allowed:true,destination:'acct_fixed',
          retry_before:deadline,idempotency_key:recoveryKey || failedKey,balance_recovery_supported:true,...guardPatch}};
        if(name==='authorize_wallet_balance_recovery') {
          recoveryKey ||= newKey;
          return loseAuthorization ? {error:{message:'lost reply after commit'}} : {data:{idempotency_key:recoveryKey}};
        }
        if(name==='complete_wallet_settlement') return {error:completeError};
        if(name==='claim_due_wallet_settlements') return {data:[]};
        return {};
      },
    }),
    fetch:async(url,opts)=>{
      requests.push({url,opts});
      assert.equal(opts.headers.Authorization,'Bearer '+secret);
      assert.equal(opts.headers['Stripe-Account'],undefined);
      if(url==='https://api.stripe.com/v1/balance') {
        assert.equal(opts.method,'GET'); return getBalance();
      }
      assert.equal(url,'https://api.stripe.com/v1/transfers');
      assert.equal(opts.method,'POST'); return postTransfer(opts);
    },
    Response,Request,URLSearchParams,AbortSignal,Date:ClockDate,console,
  });
  vm.runInContext(js,ctx);
  return {ctx,calls,requests,advance:ms=>{now+=ms;},send:(body,headers={'x-adbattle-settlement-secret':'test'})=>
    handler(new Request('https://example.test/settle',{method:'POST',headers,body}))};
}

test('cached balance rejection plus fresh funded balance persists one additional key, without spending it',async()=>{
  const w=worker();
  assert.equal((await w.ctx.recoverBalanceFailure(id)).status,'balance_recovery_authorized');
  assert.deepEqual(w.requests.map(r=>r.opts.method),['GET','POST','GET']);
  const post=w.requests[1].opts;
  assert.equal(post.headers['Idempotency-Key'],failedKey);
  const params=new URLSearchParams(post.body);
  assert.equal(params.get('amount'),'900');
  assert.equal(params.get('destination'),'acct_fixed');
  assert.equal(params.get('metadata[settlement_id]'),id);
  const auth=w.calls.find(c=>c.name==='authorize_wallet_balance_recovery').args;
  assert.equal(auth.p_available_cents,1912);
  assert.equal(auth.p_balance_request_id,'req_balance');
  assert.equal(auth.p_stripe_request_id,'req_rejected');
  assert.equal((await w.ctx.recoverBalanceFailure(id)).status,'balance_recovery_already_authorized');
  assert.equal(w.requests.length,3);
  assert.equal(w.calls.filter(c=>c.name==='authorize_wallet_balance_recovery').length,1);
});

test('only available USD card funds qualify; missing, live, malformed or low balances cannot permit a POST',async()=>{
  for(const getBalance of [
    async()=>balance(899), async()=>balance(0,{pending:[{currency:'usd',amount:5000}]}),
    async()=>balance(1912,{available:[{currency:'eur',amount:5000,source_types:{card:5000}}]}),
    async()=>balance(1912,{available:[{currency:'usd',amount:5000,source_types:{card:899,bank_account:4101}}]}),
    async()=>balance(899,{available:[{currency:'usd',amount:899,source_types:{card:5000}}]}),
    async()=>balance(1912,{livemode:true}), async()=>balance(1912,{available:[]}),
    async()=>balance(1912,{available:[{currency:'usd',amount:1912}]}),
    async()=>balance(1912,{available:[{currency:'usd',amount:'1912',source_types:{card:1912}}]}),
    async()=>balance(1912,{},{}), async()=>new Response('bad json'),
    async()=>Response.json({error:'offline'},{status:500}), async()=>{throw new Error('timeout');},
  ]) {
    const w=worker({getBalance});
    await w.ctx.recoverBalanceFailure(id).catch(()=>{});
    assert.equal(w.requests.filter(r=>r.opts.method==='POST').length,0);
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_balance_recovery'),false);
  }
});

test('non-cached, ambiguous and different failures never authorize balance recovery',async()=>{
  for(const postTransfer of [
    async()=>rejection(400,{}, {'Request-Id':'req_rejected'}),
    async()=>rejection(400,{}, {'Idempotent-Replayed':'true'}),
    async()=>rejection(400,{code:'insufficient_capabilities_for_transfer'}),
    async()=>rejection(400,{type:'api_error'}),
    async()=>rejection(409), async()=>rejection(429), async()=>rejection(500),
    async()=>{throw new Error('timeout');}, async()=>new Response('bad json',{status:400}),
    async()=>Response.json({...transfer,error:{code:'balance_insufficient',type:'invalid_request_error'}},
      {status:400,headers:{'Request-Id':'req_rejected','Idempotent-Replayed':'true'}}),
  ]) {
    const w=worker({postTransfer});
    await w.ctx.recoverBalanceFailure(id).catch(()=>{});
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_balance_recovery'),false);
  }
});

test('successful predecessor is reconciled; mismatches and failed completion never rotate its key',async()=>{
  for(const completeError of [null,{message:'database unavailable'}]) {
    const w=worker({postTransfer:async()=>Response.json(transfer),completeError});
    if(completeError) await assert.rejects(w.ctx.recoverBalanceFailure(id),/keep the existing key/);
    else assert.equal((await w.ctx.recoverBalanceFailure(id)).transfer_id,'tr_existing');
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_balance_recovery'),false);
  }
  for(const patch of [{amount:901},{currency:'eur'},{destination:'acct_other'},{metadata:{}},{object:'charge'}]) {
    const w=worker({postTransfer:async()=>Response.json({...transfer,...patch})});
    assert.equal((await w.ctx.recoverBalanceFailure(id)).reason,'transfer_details_mismatch');
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_balance_recovery'||c.name==='complete_wallet_settlement'),false);
  }
});

test('lost authorization and Stripe replies reuse the committed key even after the balance has been spent',async()=>{
  for(const completeError of [null,{message:'database unavailable'}]) {
    let created=0; let newPosts=0;
    const w=worker({loseAuthorization:true,completeError,postTransfer:async opts=>{
      if(opts.headers['Idempotency-Key']===failedKey) return rejection();
      assert.equal(opts.headers['Idempotency-Key'],newKey);
      newPosts++;
      if(newPosts===1) {created++;throw new Error('lost Stripe reply after transfer');}
      return Response.json(transfer);
    }});
    await assert.rejects(w.ctx.recoverBalanceFailure(id),/not confirmed/);
    assert.equal((await w.ctx.recoverBalanceFailure(id)).status,'balance_recovery_already_authorized');
    await assert.rejects(w.ctx.transferSettlement(row),/lost Stripe reply/);
    if(completeError) await assert.rejects(w.ctx.transferSettlement(row),/ledger completion failed/);
    else assert.equal((await w.ctx.transferSettlement(row)).status,'succeeded');
    assert.equal(created,1);
    assert.equal(w.requests.filter(r=>r.opts.method==='GET').length,2);
    const posts=w.requests.filter(r=>r.opts.method==='POST');
    assert.equal(posts[1].opts.body,posts[2].opts.body);
    assert.equal(posts[1].opts.headers['Idempotency-Key'],posts[2].opts.headers['Idempotency-Key']);
  }
});

test('changed destinations, holds, missing migrations, live keys and unrelated retry keys stop before Stripe',async()=>{
  for(const options of [
    {currentDestination:'acct_other'}, {creatorReady:false}, {status:'succeeded'}, {secret:'sk_live_fake'},
    {guardPatch:{allowed:false,reason:'manual_review'}}, {guardPatch:{allowed:false,reason:'payment_risk_hold'}},
    {guardPatch:{allowed:'true'}}, {guardPatch:{retry_before:'invalid'}},
    {guardPatch:{retry_before:new Date(Date.now()-1000).toISOString()}},
    {guardPatch:{balance_recovery_supported:false}}, {guardPatch:{idempotency_key:baseKey}},
    {guardPatch:{idempotency_key:'unexpected-key'}},
  ]) {
    const w=worker(options);
    await w.ctx.recoverBalanceFailure(id).catch(()=>{});
    assert.equal(w.requests.length,0);
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_balance_recovery'),false);
  }
});

test('funding and deadline are rechecked after slow requests before authorizing a fresh key',async()=>{
  let reads=0;
  const depleted=worker({getBalance:async()=>balance(++reads===1?1912:0)});
  assert.equal((await depleted.ctx.recoverBalanceFailure(id)).reason,'balance_or_retry_window_changed');
  assert.equal(depleted.calls.some(c=>c.name==='authorize_wallet_balance_recovery'),false);
  for(const expireAt of [1,2]) {
    let count=0;
    const w=worker({getBalance:async()=>{
      if(++count===expireAt) w.advance(3600000);
      return balance();
    }});
    assert.equal((await w.ctx.recoverBalanceFailure(id)).status,'held');
    assert.equal(w.requests.filter(r=>r.opts.method==='POST').length,expireAt===1?0:1);
    assert.equal(w.calls.some(c=>c.name==='authorize_wallet_balance_recovery'),false);
  }
});

test('balance action requires the private header and one UUID field, without claiming other settlements',async()=>{
  const w=worker(); const body=JSON.stringify({recover_balance_failure:id});
  assert.equal((await w.send(body,{})).status,401);
  for(const bad of ['null','[]','bad json',JSON.stringify({recover_balance_failure:'bad'}),
    JSON.stringify({recover_balance_failure:id,recover_capability_failure:id}),
    JSON.stringify({recover_balance_failure:id,available_cents:99999}),JSON.stringify({unknown:id})]) {
    assert.equal((await w.send(bad)).status,400);
  }
  assert.equal(w.requests.length,0);
  assert.equal((await (await w.send(body)).json()).recovery.status,'balance_recovery_authorized');
  assert.equal(w.calls.some(c=>c.name==='claim_due_wallet_settlements'),false);
  assert.equal((await (await w.send('{}')).json()).processed,0);
});

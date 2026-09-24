import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../supabase/functions/stripe-webhook/index.ts',import.meta.url),'utf8');
const js=stripTypeScriptTypes(source.replace(/^import .*;\n/gm,''));
function webhook({event,invalidSignature=false,rpcError=null,refunded=500,disputed=false}) {
  const calls=[];
  const charge={id:'ch_1',payment_intent:'pi_1',amount_refunded:refunded,disputed};
  class StripeMock {
    static createSubtleCryptoProvider(){return {};}
    webhooks={constructEventAsync:async()=>{if(invalidSignature)throw new Error('bad signature');return event;}};
    paymentIntents={retrieve:async()=>({latest_charge:'ch_1',metadata:{payment_type:'wallet_topup',wallet_user_id:'user-1'}})};
    charges={retrieve:async()=>charge};
  }
  let handler;
  const ctx=vm.createContext({Stripe:StripeMock,
    createClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{credited:true},error:rpcError};}}),
    Deno:{env:{get:()=> 'configured-test-secret'},serve:fn=>{handler=fn;}},
    Response,console:{log(){},error(){}},
  });
  vm.runInContext(js,ctx);
  return {calls,send:()=>handler(new Request('https://example.test/webhook',{
    method:'POST',headers:{'stripe-signature':'signature'},body:'signed body',
  }))};
}
test('invalid signature cannot mutate the wallet',async()=>{
  const w=webhook({invalidSignature:true});
  assert.equal((await w.send()).status,400);
  assert.equal(w.calls.length,0);
});
test('refund event invokes cumulative reversal RPC',async()=>{
  const w=webhook({event:{id:'evt_refund',type:'charge.refunded',data:{object:{payment_intent:'pi_1',amount_refunded:500}}}});
  assert.equal((await w.send()).status,200);
  assert.equal(w.calls[0].name,'record_wallet_payment_risk');
  assert.equal(w.calls[0].args.p_refunded_cents,500);
});
test('failed risk persistence returns non-2xx so Stripe retries',async()=>{
  const w=webhook({rpcError:{message:'database unavailable'},event:{id:'evt_refund',type:'charge.refunded',data:{object:{payment_intent:'pi_1',amount_refunded:500}}}});
  assert.equal((await w.send()).status,500);
});
test('won dispute still requires reconciliation, not automatic unfreezing',async()=>{
  const w=webhook({refunded:0,event:{id:'evt_won',type:'charge.dispute.closed',data:{object:{charge:'ch_1',status:'won'}}}});
  assert.equal((await w.send()).status,200);
  assert.equal(w.calls[0].args.p_dispute_seen,true);
});
test('late paid webhook records current refund risk before crediting the wallet',async()=>{
  const w=webhook({event:{id:'evt_paid',type:'checkout.session.completed',data:{object:{
    id:'cs_1',livemode:false,payment_status:'paid',currency:'usd',amount_total:1000,payment_intent:'pi_1',
    metadata:{payment_type:'wallet_topup',wallet_user_id:'user-1',amount_cents:'1000'},
  }}}});
  assert.equal((await w.send()).status,200);
  assert.deepEqual(w.calls.map(c=>c.name),['record_wallet_payment_risk','record_wallet_topup']);
});

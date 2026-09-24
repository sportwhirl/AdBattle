import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { Image } from 'imagescript/v2/index.js';
import { loadOwnedImage, requireImageDimensions } from '../supabase/functions/_shared/storage-scan-policy.ts';
import { sha256Hex } from '../supabase/functions/_shared/image-fingerprint.ts';

const source = readFileSync(new URL('../supabase/functions/submit-ai-ad/index.ts', import.meta.url),'utf8');
const script = new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'')));
const owner='00000000-0000-4000-8000-000000000001';
const stranger='00000000-0000-4000-8000-000000000002';
const requestId='00000000-0000-4000-8000-000000000321';
const project='https://nccqnrcdygujulrnwair.supabase.co';
const original=readFileSync(new URL('./fixtures/images/openai_1088x608.jpg',import.meta.url));
const image=await Image.decode('jpeg',original);
image.resize('cubic',640,360);
const canonical=await image.encode('jpeg',{quality:68});
const canonicalHash=await sha256Hex(canonical);

function setup({ user={id:owner,app_metadata:{ai_image_adult_test_approved:true}},
  draftOwner=owner, stored=canonical, postHash=canonicalHash, preexisting=null,
  failUpload=false, failInsert=false, enabled='true' }={}) {
  const calls={uploads:[],removed:[],rows:[],queries:[],bucket:[]};
  const draft={request_id:requestId,user_id:draftOwner,status:'completed',
    post_path:`${draftOwner}/${requestId}.post.jpg`,post_sha256:postHash,
    post_bytes:canonical.length,post_width:640,post_height:360};
  const pending={
    async upload(path,bytes,options) {
      calls.uploads.push({path,bytes,options});
      return {error:failUpload?{message:'upload failed'}:null};
    },
    async remove(paths){calls.removed.push(paths);return {error:null};},
  };
  const sourceBucket={
    async info(path){calls.bucket.push(['info',path]);return {data:{size:stored.length,contentType:'image/jpeg'},error:null};},
    async download(path){calls.bucket.push(['download',path]);return {data:new Blob([stored]),error:null};},
  };
  const admin={
    storage:{from(name){return name==='ai-image-drafts'?sourceBucket:pending;}},
    from(table){
      if(table==='ai_image_draft_requests')return {
        select(){return this;},eq(){return this;},
        async maybeSingle(){calls.queries.push('draft');return {data:draftOwner===user?.id?draft:null,error:null};},
      };
      assert.equal(table,'ads');
      const chain={
        select(){return this;},eq(){return this;},
        async maybeSingle(){calls.queries.push('existing');return {data:preexisting,error:null};},
        insert(payload){calls.rows.push(payload);return this;},
        async single(){return failInsert?{data:null,error:{message:'conflict'}}:
          {data:{id:7},error:null};},
      };
      return chain;
    },
  };
  const env={SUPABASE_URL:project,SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',
    ADBATTLE_AI_IMAGE_ENABLED:enabled,ADBATTLE_AI_IMAGE_POST_ENABLED:enabled};
  let handler;
  script.runInNewContext({
    Deno:{env:{get:key=>env[key]},serve:fn=>{handler=fn;}},
    createClient:(_url,key)=>key==='anon'?
      {auth:{async getUser(){return {data:{user},error:null};}}}:admin,
    corsPreflightResponse:()=>new Response(null,{status:204}),
    jsonResponse:(_req,body,status=200)=>Response.json(body,{status}),
    parseBearerToken:req=>req.headers.get('authorization')?.replace(/^Bearer /,''),
    loadOwnedImage,requireImageDimensions,sha256Hex,
    Request,Response,Blob,Uint8Array,TextDecoder,crypto:globalThis.crypto,console,
  });
  return {calls,async send({body={},origin='http://localhost:8000',authorization='Bearer session'}={}){
    const response=await handler(new Request(project+'/functions/v1/submit-ai-ad',{
      method:'POST',headers:{origin,authorization,'content-type':'application/json'},
      body:JSON.stringify({request_id:requestId,title:'A tiny world',caption:'A friendly planet',...body}),
    }));
    return {status:response.status,body:await response.json()};
  }};
}

test('trusted submit copies only canonical private bytes into one pending AI ad',async()=>{
  const app=setup();
  const result=await app.send({body:{title:'  A tiny world  '}});
  assert.equal(result.status,200);
  assert.equal(result.body.ad_id,7);
  assert.equal(app.calls.uploads.length,1);
  assert.deepEqual(Buffer.from(app.calls.uploads[0].bytes),Buffer.from(canonical));
  assert.match(app.calls.uploads[0].path,new RegExp(`^${owner}/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(app.calls.uploads[0].options.upsert,false);
  assert.equal(app.calls.rows[0].ai_source_request_id,requestId);
  assert.equal(app.calls.rows[0].image_storage_path,app.calls.uploads[0].path);
  assert.equal(app.calls.rows[0].title,'A tiny world');
  assert.ok(!Object.hasOwn(app.calls.rows[0],'ai_generated'));
});

test('replay returns the existing owner ad without another copy',async()=>{
  const app=setup({preexisting:{id:19,user_id:owner}});
  assert.equal((await app.send()).body.ad_id,19);
  assert.equal(app.calls.uploads.length,0);
});

test('wrong origin, disabled project, anonymous or unapproved account never reads draft',async()=>{
  const cases=[
    [setup(),{origin:'https://adbattle.io'},403],
    [setup({enabled:'false'}),{},503],
    [setup({user:{id:owner,is_anonymous:true}}),{},401],
    [setup({user:{id:owner,user_metadata:{ai_image_adult_test_approved:true}}}),{},403],
  ];
  for(const [app,request,status] of cases){
    assert.equal((await app.send(request)).status,status);
    assert.equal(app.calls.queries.length,0);
  }
});

test('cross-owner source, tampered bytes and caller image fields cannot create an AI ad',async()=>{
  const cross=setup({draftOwner:stranger});
  assert.equal((await cross.send()).status,404);
  const changed=canonical.slice();changed[changed.length-1]^=1;
  const tampered=setup({stored:changed});
  assert.equal((await tampered.send()).body.error,'CANONICAL_DRAFT_INVALID');
  assert.equal(tampered.calls.uploads.length,0);
  const forged=setup();
  assert.equal((await forged.send({body:{image_storage_path:`${owner}/forged.jpg`}})).status,400);
  assert.equal(forged.calls.queries.length,0);
});

test('storage or ad INSERT failure leaves no tagged ad, and failed INSERT removes its own object',async()=>{
  const upload=setup({failUpload:true});
  assert.equal((await upload.send()).body.error,'PRIVATE_AD_UPLOAD_FAILED');
  assert.equal(upload.calls.rows.length,0);
  const insert=setup({failInsert:true});
  assert.equal((await insert.send()).body.error,'AD_INSERT_FAILED');
  assert.equal(insert.calls.rows.length,1);
  assert.equal(insert.calls.removed[0][0],insert.calls.uploads[0].path);
});

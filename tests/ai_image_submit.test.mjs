import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { Image } from 'imagescript/v2/index.js';
import { loadOwnedImage, requireImageDimensions } from '../supabase/functions/_shared/storage-scan-policy.ts';
import { sha256Hex } from '../supabase/functions/_shared/image-fingerprint.ts';

const source = readFileSync(new URL('../supabase/functions/submit-ai-ad/index.ts', import.meta.url),'utf8');
const script = new vm.Script(`'use strict';\n${stripTypeScriptTypes(source.replace(/^import .*;\n/gm,''))}`);
const owner='00000000-0000-4000-8000-000000000001';
const stranger='00000000-0000-4000-8000-000000000002';
const requestId='00000000-0000-4000-8000-000000000321';
const pendingPath=`${owner}/${requestId}.jpg`;
const project='https://nccqnrcdygujulrnwair.supabase.co';
const original=readFileSync(new URL('./fixtures/images/openai_1088x608.jpg',import.meta.url));
const image=await Image.decode('jpeg',original);
image.resize('cubic',640,360);
const canonical=await image.encode('jpeg',{quality:68});
const canonicalHash=await sha256Hex(canonical);

function setup({ user={id:owner,app_metadata:{ai_image_adult_test_approved:true}},
  draftOwner=owner, stored=canonical, postHash=canonicalHash, preexisting=null,
  failUpload=false, uploadOutcome=null, existingPending=null,
  failInsert=false, insertCommitThenThrow=false, insertThrowNoCommit=false,
  reconcileFailure=false, concurrentWinnerPath=null, enabled='true' }={}) {
  const calls={uploads:[],removed:[],rows:[],queries:[],bucket:[],pendingReads:[]};
  let adRow=preexisting;
  let pendingBytes=existingPending ? Uint8Array.from(existingPending) : null;
  let existingLookups=0;
  const draft={request_id:requestId,user_id:draftOwner,status:'completed',
    post_path:`${draftOwner}/${requestId}.post.jpg`,post_sha256:postHash,
    post_bytes:canonical.length,post_width:640,post_height:360};
  const pending={
    async upload(path,bytes,options) {
      calls.uploads.push({path,bytes,options});
      const outcome=uploadOutcome ?? (failUpload?'error':'success');
      if(['success','commit_then_error','commit_then_throw'].includes(outcome)){
        pendingBytes=Uint8Array.from(bytes);
      }
      if(outcome==='commit_then_throw')throw new Error('upload response lost after commit');
      return {error:['error','commit_then_error'].includes(outcome)?{message:'upload failed'}:null};
    },
    async info(path){
      calls.pendingReads.push(['info',path]);
      return pendingBytes
        ? {data:{size:pendingBytes.length,contentType:'image/jpeg'},error:null}
        : {data:null,error:{message:'not found'}};
    },
    async download(path){
      calls.pendingReads.push(['download',path]);
      return pendingBytes
        ? {data:new Blob([pendingBytes]),error:null}
        : {data:null,error:{message:'not found'}};
    },
    async remove(paths){calls.removed.push(paths);pendingBytes=null;return {error:null};},
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
        async maybeSingle(){
          calls.queries.push('existing');
          existingLookups++;
          if(reconcileFailure&&existingLookups>1)return {data:null,error:{message:'read unavailable'}};
          return {data:adRow,error:null};
        },
        insert(payload){calls.rows.push(payload);return this;},
        async single(){
          const inserted=calls.rows.at(-1);
          if(insertCommitThenThrow){
            adRow={id:7,...inserted};
            throw new Error('response lost after commit');
          }
          if(insertThrowNoCommit)throw new Error('write outcome unknown');
          if(failInsert){
            if(concurrentWinnerPath){
              adRow={id:23,user_id:owner,title:inserted.title,caption:inserted.caption,
                image_storage_path:concurrentWinnerPath};
            }
            return {data:null,error:{message:'conflict'}};
          }
          adRow={id:7,...inserted};
          return {data:{id:7},error:null};
        },
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
  assert.equal(app.calls.uploads[0].path,pendingPath);
  assert.equal(app.calls.uploads[0].options.upsert,false);
  assert.equal(app.calls.rows[0].ai_source_request_id,requestId);
  assert.equal(app.calls.rows[0].image_storage_path,app.calls.uploads[0].path);
  assert.equal(app.calls.rows[0].title,'A tiny world');
  assert.ok(!Object.hasOwn(app.calls.rows[0],'ai_generated'));
});

test('replay returns the existing owner ad without another copy',async()=>{
  const app=setup({preexisting:{id:19,user_id:owner,title:'A tiny world',
    caption:'A friendly planet',image_storage_path:pendingPath}});
  assert.equal((await app.send()).body.ad_id,19);
  assert.equal(app.calls.uploads.length,0);
});

test('replay is bound to owner, deterministic path, normalized title and caption',async()=>{
  const exact={id:19,user_id:owner,title:'A tiny world',caption:'A friendly planet',
    image_storage_path:pendingPath};
  const changed=setup({preexisting:exact});
  const changedResult=await changed.send({body:{title:'A different world'}});
  assert.equal(changedResult.status,409);
  assert.equal(changedResult.body.error,'SUBMISSION_CONFLICT');
  assert.equal(changed.calls.uploads.length,0);

  const wrongPath=setup({preexisting:{...exact,image_storage_path:`${owner}/other.jpg`}});
  assert.equal((await wrongPath.send()).body.error,'SUBMISSION_CONFLICT');

  const wrongOwner=setup({preexisting:{...exact,user_id:stranger}});
  const ownerResult=await wrongOwner.send();
  assert.equal(ownerResult.status,409);
  assert.equal(ownerResult.body.error,'DRAFT_ALREADY_USED');
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

test('storage failure creates no row, while an inconclusive INSERT retains its private object',async()=>{
  const upload=setup({failUpload:true});
  assert.equal((await upload.send()).body.error,'PRIVATE_AD_UPLOAD_FAILED');
  assert.equal(upload.calls.rows.length,0);
  const insert=setup({failInsert:true});
  assert.equal((await insert.send()).body.error,'AD_INSERT_FAILED');
  assert.equal(insert.calls.rows.length,1);
  assert.deepEqual(insert.calls.removed,[]);
});

test('commit-then-error pending upload reuses the exact deterministic object',async()=>{
  for(const uploadOutcome of ['commit_then_error','commit_then_throw']){
    const app=setup({uploadOutcome});
    const result=await app.send();
    assert.equal(result.status,200);
    assert.equal(result.body.ad_id,7);
    assert.equal(app.calls.uploads.length,1);
    assert.deepEqual(app.calls.pendingReads,[
      ['info',pendingPath],['download',pendingPath],
    ]);

    const replay=await app.send();
    assert.equal(replay.status,200);
    assert.equal(replay.body.ad_id,7);
    assert.equal(app.calls.uploads.length,1);
    assert.equal(app.calls.rows.length,1);
  }
});

test('upload error with different existing pending bytes fails closed',async()=>{
  const changed=canonical.slice();changed[changed.length-1]^=1;
  const app=setup({uploadOutcome:'error',existingPending:changed});
  const result=await app.send();
  assert.equal(result.status,503);
  assert.equal(result.body.error,'PRIVATE_AD_UPLOAD_FAILED');
  assert.equal(app.calls.rows.length,0);
  assert.deepEqual(app.calls.removed,[]);
});

test('lost INSERT response preserves the committed ad object and replay is idempotent',async()=>{
  const app=setup({insertCommitThenThrow:true});
  const first=await app.send();
  assert.equal(first.status,200);
  assert.equal(first.body.ad_id,7);
  assert.equal(app.calls.uploads.length,1);
  assert.deepEqual(app.calls.removed,[]);

  const replay=await app.send();
  assert.equal(replay.status,200);
  assert.equal(replay.body.ad_id,7);
  assert.equal(app.calls.uploads.length,1);
  assert.equal(app.calls.rows.length,1);
});

test('unknown INSERT state retains pending object for reconciliation',async()=>{
  const app=setup({failInsert:true,reconcileFailure:true});
  const result=await app.send();
  assert.equal(result.status,503);
  assert.equal(result.body.error,'AD_INSERT_FAILED');
  assert.equal(app.calls.uploads.length,1);
  assert.deepEqual(app.calls.removed,[]);
});

test('transport-lost INSERT with an empty read still retains pending object',async()=>{
  const app=setup({insertThrowNoCommit:true});
  const result=await app.send();
  assert.equal(result.status,503);
  assert.equal(result.body.error,'AD_INSERT_FAILED');
  assert.equal(app.calls.uploads.length,1);
  assert.deepEqual(app.calls.removed,[]);
});

test('concurrent winning ad shares the deterministic object without cleanup',async()=>{
  const app=setup({failInsert:true,concurrentWinnerPath:pendingPath});
  const result=await app.send();
  assert.equal(result.status,200);
  assert.equal(result.body.ad_id,23);
  assert.deepEqual(app.calls.removed,[]);
  assert.equal(app.calls.uploads[0].path,pendingPath);
});

test('concurrent row with conflicting payload fails closed and retains the object',async()=>{
  const app=setup({failInsert:true,concurrentWinnerPath:`${owner}/other.jpg`});
  const result=await app.send();
  assert.equal(result.status,409);
  assert.equal(result.body.error,'SUBMISSION_CONFLICT');
  assert.deepEqual(app.calls.removed,[]);
});

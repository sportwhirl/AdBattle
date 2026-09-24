import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { requireOwnedStoragePath } from '../supabase/functions/_shared/storage-scan-policy.ts';

const source=readFileSync(new URL('../supabase/functions/pending-ad-previews/index.ts',import.meta.url),'utf8');
const script=new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'')));
const owner='00000000-0000-4000-8000-000000000001';
const stranger='00000000-0000-4000-8000-000000000002';
let handler, signed;
const row={id:8,user_id:owner,image_storage_path:`${owner}/00000000-0000-4000-8000-000000000003.png`,
  moderation_status:'pending_scan',image_publication_state:'pending'};
const admin={
  auth:{async getUser(token) { return token==='owner-token'
    ? {data:{user:{id:owner}},error:null} : {data:null,error:{message:'Invalid'}}; }},
  from(table) { assert.equal(table,'ads'); return {select() {return this;},async in(key,ids) {
    assert.equal(key,'id'); return {data:ids.includes(row.id)?[{...row}]:[],error:null};
  }}; },
  storage:{from(bucket) { assert.equal(bucket,'ad-pending-images'); return {
    async createSignedUrl(path,seconds) {
      signed++; assert.equal(path,row.image_storage_path); assert.equal(seconds,60);
      return {data:{signedUrl:'https://example.supabase.co/storage/v1/object/sign/ad-pending-images/private-token'},error:null};
    },
  }; }},
};
script.runInNewContext({
  Deno:{env:{get:key=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service'})[key]},
    serve:fn=>{handler=fn;}},
  createClient:()=>admin,requestOriginAllowed:()=>true,
  corsPreflightResponse:()=>new Response(null,{status:204}),
  parseBearerToken:req=>req.headers.get('authorization')?.replace(/^Bearer /,'') || null,
  requireOwnedStoragePath,Request,Response,Number,Set,
  jsonResponse:(_req,body,status=200)=>Response.json(body,{status}),
});

async function preview(token,ids) {
  signed=0;
  const result=await handler(new Request('https://example.supabase.co/functions/v1/pending-ad-previews',{
    method:'POST',headers:token?{authorization:`Bearer ${token}`}:{},body:JSON.stringify({ad_ids:ids}),
  }));
  return {status:result.status,body:await result.json(),signs:signed};
}

test('owner gets a sixty-second URL without a public pending URL',async()=>{
  const result=await preview('owner-token',[8]);
  assert.equal(result.status,200);
  assert.equal(result.signs,1);
  assert.match(result.body.previews['8'],/\/object\/sign\//);
  assert.doesNotMatch(JSON.stringify(result.body),/\/object\/public\//);
});

test('missing auth, another owner, and nonpending status fail before signing',async()=>{
  assert.equal((await preview(null,[8])).status,401);
  assert.equal((await preview('stranger-token',[8])).status,401);
  row.user_id=stranger;
  try { const result=await preview('owner-token',[8]); assert.equal(result.status,403); assert.equal(result.signs,0); }
  finally { row.user_id=owner; }
  row.moderation_status='rejected';
  try { const result=await preview('owner-token',[8]); assert.equal(result.status,403); assert.equal(result.signs,0); }
  finally { row.moderation_status='pending_scan'; }
});

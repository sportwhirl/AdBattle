import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { requireOwnedStoragePath } from '../supabase/functions/_shared/storage-scan-policy.ts';

const source=readFileSync(new URL('../supabase/functions/moderator-ad-previews/index.ts',import.meta.url),'utf8');
const script=new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'')));
const owner='00000000-0000-4000-8000-000000000001';
const reviewerId='00000000-0000-4000-8000-000000000002';
const url='https://test.supabase.co';
const version='a'.repeat(32);
function harness(options={}) {
  let handler,reads=0;
  const signed=[],queries=[];
  const original={id:'2',owner_id:owner,image_storage_path:`${owner}/original.png`};
  const detail={ad:{id:'8',owner_id:owner,image_storage_path:`${owner}/resized.png`,
    safety_status:'passed',duplicate_status:'review_similar',moderation_status:'pending_scan',matched_ad:original},version};
  const rows=[{id:8,user_id:owner,image_storage_path:detail.ad.image_storage_path,image_publication_state:'pending'},
    {id:2,user_id:owner,image_storage_path:original.image_storage_path,image_publication_state:'legacy_public'}];
  const deny={message:'MODERATOR_ACCESS_REQUIRED',code:'42501'};
  const admin={auth:{async getUser(token) {return token==='bad' ? {error:{message:'bad'},data:null} : {data:{user:{id:reviewerId}}};}},
    from(table){assert.equal(table,'ads');return {select(){return this;},async in(key,ids){queries.push(Array.from(ids));return {data:rows,error:null};}};},
    storage:{from(bucket){return {async createSignedUrl(path,ttl){
      signed.push({bucket,path,ttl});
      if(options.signFailure) throw Error('sensitive provider error token=secret');
      return {data:{signedUrl:`${url}/storage/v1/object/sign/${bucket}/${path}?token=private`}};
    }};}},
  };
  const client={async rpc(name,args){
    assert.equal(name,'moderator_ad');assert.deepEqual(JSON.parse(JSON.stringify(args)),{p_ad_id:'8'});reads++;
    if(options.ordinary || (options.revoked && reads===2)) return {error:deny};
    if(options.changed && reads===2) return {data:{...detail,version:'b'.repeat(32)}};
    if(options.resolved && reads===2) return {data:{...detail,ad:{...detail.ad,duplicate_status:'passed'}}};
    return {data:detail};
  }};
  script.runInNewContext({Deno:{env:{get:key=>({SUPABASE_URL:url,SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service'})[key]},serve:fn=>{handler=fn;}},
    createClient:(target,key,opts)=>{
      assert.equal(target,url);
      if(key==='service') return admin;
      assert.equal(key,'public');assert.equal(opts.global.headers.Authorization,`Bearer ${options.token || 'valid'}`);return client;
    },
    requestOriginAllowed:()=>!options.badOrigin,corsPreflightResponse:()=>new Response(null,{status:204}),
    parseBearerToken:req=>req.headers.get('authorization')?.replace(/^Bearer /,'') || null,
    jsonResponse:(_req,body,status=200)=>Response.json(body,{status}),
    requireOwnedStoragePath,Request,Response,TextEncoder,BigInt,Set,
  });
  return {detail,rows,signed,queries,async call(body={ad_id:'8',expected_version:version},token=options.token || 'valid'){
    const response=await handler(new Request(url+'/functions/v1/moderator-ad-previews',{
      method:'POST',headers:token?{authorization:`Bearer ${token}`}:{},body:JSON.stringify(body),
    }));
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {status:response.status,body:await response.json(),reads};
  }};
}

test('verified reviewer gets both original objects for sixty seconds using user-scoped RPC',async()=>{
  const h=harness();const r=await h.call();assert.equal(r.status,200);assert.equal(r.reads,2);
  assert.deepEqual(h.queries,[['8','2']]);
  assert.deepEqual(h.signed.map(s=>[s.bucket,s.ttl]),[['ad-pending-images',60],['ad-images',60]]);
  assert.equal(r.body.version,version);assert.equal(r.body.ad_id,'8');assert.equal(r.body.expires_in,60);
  assert.deepEqual(Object.keys(r.body.previews),['2','8']);
});
test('missing/invalid JWT and ordinary authenticated users receive no storage access',async()=>{
  for(const [opts,token,status] of [[{},null,401],[{token:'bad'},'bad',401],[{ordinary:true},'valid',403],[{badOrigin:true},'valid',403]]){
    const h=harness(opts);const r=await h.call(undefined,token);assert.equal(r.status,status);assert.equal(h.signed.length,0);assert.equal(h.queries.length,0);
  }
});
test('client-selected paths, extra ad IDs, stale versions and completed reviews cannot request a preview',async()=>{
  for(const body of [{ad_id:'8',expected_version:version,path:'other/private.png'},
    {ad_id:'8',expected_version:version,ad_ids:['9']}, {ad_id:8,expected_version:version},
    {ad_id:'8',expected_version:'b'.repeat(32)}, {ad_id:'0',expected_version:version}]){
    const h=harness();assert.ok([400,409].includes((await h.call(body)).status));assert.equal(h.signed.length,0);
  }
  const h=harness();h.detail.ad.duplicate_status='passed';assert.equal((await h.call()).status,409);assert.equal(h.signed.length,0);
});
test('revocation, snapshot change or resolved review during signing discards all URLs',async()=>{
  for(const opts of [{revoked:true},{changed:true},{resolved:true}]){
    const h=harness(opts);const r=await h.call();assert.ok([403,409].includes(r.status));assert.equal(h.signed.length,2);assert.equal(r.body.previews,undefined);assert.doesNotMatch(JSON.stringify(r.body),/token=|object\/sign/);
  }
});
test('row owner/path mismatch and unsupported publication states fail before signing',async()=>{
  for(const change of [{user_id:reviewerId},{image_storage_path:`${reviewerId}/foreign.png`},{image_publication_state:'unknown'}]){
    const h=harness();Object.assign(h.rows[0],change);assert.equal((await h.call()).status,503);assert.equal(h.signed.length,0);
  }
  const h=harness();h.rows[0].image_storage_path=h.detail.ad.image_storage_path=`${owner}/../foreign.png`;
  assert.equal((await h.call()).status,503);assert.equal(h.signed.length,0);
});
test('newly public matched ads use their private original and storage failures are sanitized',async()=>{
  const h=harness();h.rows[1].image_publication_state='public';assert.equal((await h.call()).status,200);
  assert.equal(h.signed[1].bucket,'ad-pending-images');
  const bad=harness({signFailure:true});const r=await bad.call();assert.equal(r.status,503);assert.deepEqual(r.body,{error:'PREVIEW_UNAVAILABLE'});
});

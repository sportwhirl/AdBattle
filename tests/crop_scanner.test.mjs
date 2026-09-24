import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import {parseDuplicateScanRequest,DuplicateScanRequestError} from '../supabase/functions/_shared/duplicate-scan-request.ts';
const source=readFileSync(new URL('../supabase/functions/scan-ad-duplicate/index.ts',import.meta.url),'utf8');
const script=new vm.Script(stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\n/gm,'')));
function harness(options={}){
 let handler,decoded=false;
 const calls=[],downloads=[];
 const row={id:8,user_id:'owner',image_storage_path:'owner/private.jpg',duplicate_status:'pending',image_index_required:false,image_publication_state:'pending',...options.row};
 const client={from(table){return {select(){return this},eq(){return this},async single(){return {data:table==='ads'?row:{ready:true}}}}},
 storage:{from(bucket){return {bucket}}},async rpc(name,args){calls.push({name,args});return (options.rpcError||options.rpcErrorAt===calls.length)?{error:{message:'INDEXED_IMAGE_BYTES_CHANGED'}}:{data:{status:name==='record_ad_crop_fingerprint'?'crop_indexed':'review_similar'}}}};
 script.runInNewContext({Deno:{env:{get:key=>({SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'service',DUPLICATE_SCANNER_WEBHOOK_SECRET:'hook',ADBATTLE_BACKFILL_SECRET:'backfill'})[key]},serve:fn=>handler=fn},
 createClient:()=>client,requestOriginAllowed:()=>true,corsPreflightResponse:()=>new Response(null,{status:204}),
 jsonResponse:(_req,data,status=200)=>Response.json(data,{status}),parseDuplicateScanRequest,DuplicateScanRequestError,
 async loadOwnedImage(bucket,owner,path){downloads.push({bucket:bucket.bucket,owner,path});if(options.storageError)throw Error('missing bytes');return new Uint8Array([1,2])},
 async decode(){return {width:120,height:100,getRGBAAt:options.unsupportedDecode?undefined:()=>[0,0,0,255],resize(w,h){decoded=true;assert.equal(w,9);assert.equal(h,8)}}},
 cropFingerprint(image){assert.equal(decoded,false);assert.equal(image.width,120);return {version:'fixture'}},
 sha256Hex:async()=> 'ab'.repeat(32),differenceHash:()=>{assert.equal(decoded,true);return 'ab'.repeat(8)},VISUAL_HASH_VERSION:'dhash-9x8-luma-v1',
 Request,Response,Uint8Array,
 });
 return {calls,downloads,async call(body={type:'INSERT',table:'ads',schema:'public',record:{id:8}},headers={'x-adbattle-duplicate-scanner-secret':'hook'}){
 const r=await handler(new Request('https://test.invalid',{method:'POST',headers,body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};
 }};
}
test('webhook uses reloaded private source and records both fingerprints atomically',async()=>{
 const h=harness();const r=await h.call({type:'INSERT',table:'ads',schema:'public',record:{id:8,image_storage_path:'evil/source',user_id:'other'}});
 assert.equal(r.status,200);assert.equal(h.calls[0].name,'record_ad_duplicate_scan_v2');assert.ok(h.calls[0].args.p_crop_fingerprint);
 assert.deepEqual(h.downloads,[{bucket:'ad-pending-images',owner:'owner',path:'owner/private.jpg'}]);
});
test('crop backfill authenticates separately and uses private original even for newly public ads',async()=>{
 for(const state of ['pending','public','legacy_public']){
 const h=harness({row:{image_publication_state:state,duplicate_status:'rejected'}});
 const r=await h.call({crop_backfill_ad_id:8},{'x-adbattle-backfill-secret':'backfill'});assert.equal(r.status,200);
 assert.equal(h.downloads[0].bucket,state==='legacy_public'?'ad-images':'ad-pending-images');
 assert.deepEqual(h.calls.map(c=>c.name),['record_ad_crop_fingerprint']);
 }
 for(const [body,headers,expected] of [[{crop_backfill_ad_id:8},{'x-adbattle-duplicate-scanner-secret':'hook'},401],
 [{crop_backfill_ad_id:8,record:{id:9}},{'x-adbattle-backfill-secret':'backfill'},400],
 [{crop_backfill_ad_id:8,legacy_ad_id:8},{'x-adbattle-backfill-secret':'backfill'},400]]){
 const h=harness();assert.equal((await h.call(body,headers)).status,expected);assert.equal(h.downloads.length,0);assert.equal(h.calls.length,0);
 }
});
test('backfill errors never invoke moderation refresh or reset a completed decision',async()=>{
 for(const opts of [{storageError:true},{rpcError:true}]){
 const h=harness({...opts,row:{duplicate_status:'rejected'}});assert.equal((await h.call({crop_backfill_ad_id:8},{'x-adbattle-backfill-secret':'backfill'})).status,503);
 assert.ok(h.calls.every(c=>c.name==='record_ad_crop_fingerprint'));
 }
 const h=harness({row:{duplicate_status:'rejected'}});assert.equal((await h.call()).body.status,'rejected');assert.equal(h.downloads.length,0);
});
test('legacy indexing also requires crop backfill; a failed second step stays incomplete',async()=>{
 const h=harness({row:{image_index_required:true,image_publication_state:'legacy_public'}});
 assert.equal((await h.call({legacy_ad_id:8},{'x-adbattle-backfill-secret':'backfill'})).status,200);
 assert.deepEqual(h.calls.map(c=>c.name),['record_ad_legacy_fingerprint','record_ad_crop_fingerprint']);
 assert.equal(h.downloads[0].bucket,'ad-images');
 const failed=harness({row:{image_index_required:true,image_publication_state:'legacy_public'},rpcErrorAt:2});
 assert.equal((await failed.call({legacy_ad_id:8},{'x-adbattle-backfill-secret':'backfill'})).status,503);
 assert.deepEqual(failed.calls.map(c=>c.name),['record_ad_legacy_fingerprint','record_ad_crop_fingerprint','record_ad_legacy_scan_failure']);
});

test('unsupported decode result never records a successful scan',async()=>{
 const h=harness({unsupportedDecode:true});assert.equal((await h.call()).status,503);
 assert.deepEqual(h.calls.map(c=>c.name),['record_ad_duplicate_scan_failure']);
});

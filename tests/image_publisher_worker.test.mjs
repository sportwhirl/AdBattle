import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { loadOwnedImage } from '../supabase/functions/_shared/storage-scan-policy.ts';
import { sha256Hex } from '../supabase/functions/_shared/image-fingerprint.ts';

const source = readFileSync(new URL('../supabase/functions/publish-ad-image/index.ts',import.meta.url),'utf8');
const script = new vm.Script(stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'')));
const owner='00000000-0000-4000-8000-000000000001';
const pendingPath=`${owner}/00000000-0000-4000-8000-000000000002.png`;
const png = new Uint8Array(readFileSync(new URL('./fixtures/images/valid.png',import.meta.url)));
const secret='test-publication-worker-secret-at-least-32-chars';
const projectUrl='https://example.supabase.co';

function bucket(sourceBytes, state, name) {
  return {
    async info(path) {
      state.calls.push([name,'info',path]);
      return sourceBytes() ? { data:{size:sourceBytes().length,contentType:'image/png'},error:null }
        : {data:null,error:{message:'Not found'}};
    },
    async download(path) {
      state.calls.push([name,'download',path]);
      return sourceBytes() ? {data:new Blob([sourceBytes()]),error:null} : {data:null,error:{message:'Not found'}};
    },
    async upload(path, bytes, options) {
      state.calls.push([name,'upload',path]);
      assert.equal(options.upsert,false);
      assert.equal(options.contentType,'image/png');
      if (state.uploadError) return {data:null,error:state.uploadError};
      if (state.uploadThrows) throw new Error('Response lost after upload');
      if (state.publicBytes) return {data:null,error:{message:'Resource already exists',statusCode:'409'}};
      state.publicBytes=new Uint8Array(bytes);
      return {data:{path},error:null};
    },
    getPublicUrl(path) { return {data:{publicUrl:`${projectUrl}/storage/v1/object/public/ad-images/${path}`}}; },
  };
}

async function worker({ privateBytes=png, publicBytes=null, scanHash, beforeState='pending', sweep=false,
                        aiSource=null, aiPostSha=null, configuredSecret=secret,
                        uploadError=null, uploadThrows=false }={}) {
  const goodHash=await sha256Hex(png);
  const expectedSha=scanHash || goodHash;
  const state={calls:[],publicBytes,uploadError,uploadThrows,complete:0,eligibleFilter:null};
  const privateBucket=bucket(()=>privateBytes,state,'private');
  const publicBucket=bucket(()=>state.publicBytes,state,'public');
  const admin={
    from(table) {
      if (table==='ad_image_publication_queue') return {
        delete() {return this;},eq() {return {error:null};},
        select() {return this;},order() {return this;},
        lte(column,value) {state.eligibleFilter=[column,value];return this;},
        async limit() {return {data:[{ad_id:7}],error:null};},
      };
      assert.equal(table,'ads');
      return {select() {return this;},eq() {return this;},async single() {
        return {data:{id:7,user_id:owner,image_storage_path:pendingPath,
          image_publication_state:beforeState,ai_source_request_id:aiSource,
          ai_post_sha256:aiPostSha},error:null};
      }};
    },
    storage:{from(name) { return name==='ad-pending-images' ? privateBucket : publicBucket; }},
    async rpc(name,args) {
      state.calls.push(['rpc',name]);
      if (name==='defer_ad_image_publication') return {data:null,error:null};
      if (name==='claim_ad_image_publication') return {data:[{
        public_path:`${owner}/7-${expectedSha}`,expected_sha256:expectedSha}],error:null};
      assert.equal(name,'complete_ad_image_publication');
      state.complete++;
      assert.equal(args.p_sha256,expectedSha);
      return {data:'approved',error:null};
    },
  };
  let handler;
  script.runInNewContext({
    Deno:{env:{get:key=>({SUPABASE_URL:projectUrl,SUPABASE_SERVICE_ROLE_KEY:'service',
      ADBATTLE_IMAGE_PUBLISHER_SECRET:configuredSecret})[key]},serve:fn=>{handler=fn;}},
    createClient:()=>admin,loadOwnedImage,sha256Hex,Request,Response,Blob,Uint8Array,Number,
    console:{error(){}},
    jsonResponse:(_req,body,status=200)=>Response.json(body,{status}),
  });
  const response=await handler(new Request(`${projectUrl}/functions/v1/publish-ad-image`,{
    method:'POST',headers:{'x-adbattle-publisher-secret':secret},
    body:JSON.stringify(sweep?{action:'sweep'}:{ad_id:7}),
  }));
  return {status:response.status,body:await response.json(),state};
}

test('publisher verifies fresh private and public bytes before finalizing', async () => {
  const result=await worker();
  assert.equal(result.status,200);
  assert.equal(result.body.status,'approved');
  assert.equal(result.state.complete,1);
  assert.ok(result.state.calls.find(c=>c[0]==='public' && c[1]==='download'));
});

test('publisher accepts the exact header when Dashboard saved one terminal LF', async () => {
  const result=await worker({configuredSecret:`${secret}\n`});
  assert.equal(result.status,200);
  assert.equal(result.body.status,'approved');
});

test('changed pending object cannot be copied or published', async () => {
  const changed=png.slice(); changed[changed.length-1]^=1;
  const result=await worker({privateBytes:changed});
  assert.equal(result.status,503);
  assert.equal(result.state.complete,0);
  assert.ok(!result.state.calls.some(c=>c[1]==='upload'));
});

test('retry handles existing verified public copy but refuses a different copy', async () => {
  const retry=await worker({publicBytes:png.slice()});
  assert.equal(retry.status,200);
  assert.equal(retry.state.complete,1);
  const changed=png.slice(); changed[changed.length-1]^=1;
  const bad=await worker({publicBytes:changed});
  assert.equal(bad.status,503);
  assert.equal(bad.state.complete,0);
});

test('unfamiliar upload conflict or lost response accepts only a verified existing copy', async () => {
  const conflict={message:'Target occupied',statusCode:'409'};
  const matched=await worker({publicBytes:png.slice(),uploadError:conflict});
  assert.equal(matched.status,200);
  assert.equal(matched.state.complete,1);
  const lost=await worker({publicBytes:png.slice(),uploadThrows:true});
  assert.equal(lost.status,200);
  assert.equal(lost.state.complete,1);
  const changed=png.slice(); changed[changed.length-1]^=1;
  const mismatched=await worker({publicBytes:changed,uploadError:conflict});
  assert.equal(mismatched.status,503);
  assert.equal(mismatched.state.complete,0);
  const missing=await worker({uploadError:conflict});
  assert.equal(missing.status,503);
  assert.equal(missing.state.complete,0);
  assert.ok(missing.state.calls.some(call=>call[1]==='defer_ad_image_publication'));
});

test('scheduled sweep retries a queued interrupted publication', async () => {
  const result=await worker({beforeState:'publishing',sweep:true});
  assert.equal(result.status,200);
  assert.equal(result.body.completed,1);
  assert.equal(result.body.deferred,0);
  assert.equal(result.state.complete,1);
  assert.equal(result.state.eligibleFilter[0],'next_attempt_at');
});

test('AI provenance hash must match scanner hash before any public upload', async () => {
  const result=await worker({aiSource:'00000000-0000-4000-8000-000000000321',
    aiPostSha:'0'.repeat(64)});
  assert.equal(result.status,503);
  assert.equal(result.state.complete,0);
  assert.ok(!result.state.calls.some(call=>call[1]==='upload'));
  assert.ok(result.state.calls.some(call=>call[1]==='defer_ad_image_publication'));
});

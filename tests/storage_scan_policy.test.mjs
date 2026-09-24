import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadOwnedImage,
  MAX_IMAGE_BYTES,
  requireSupportedImage,
} from '../supabase/functions/_shared/storage-scan-policy.ts';
import { readFileSync } from 'node:fs';

const owner = '00000000-0000-4000-8000-000000000001';
const signatures = {
  'image/jpeg': readFileSync(new URL('./fixtures/images/valid.jpg',import.meta.url)),
  'image/png': readFileSync(new URL('./fixtures/images/valid.png',import.meta.url)),
};

function bucketFor(type='image/png', size=signatures[type].length) {
  const calls = [];
  return { calls,
    async info(path) { calls.push(['info',path]); return {data:{size,contentType:type},error:null}; },
    async download(path) { calls.push(['download',path]); return {data:new Blob([new Uint8Array(signatures[type])]),error:null}; },
  };
}

test('foreign and traversal paths are rejected before any service-role storage operation', async () => {
  for (const path of [
    '00000000-0000-4000-8000-000000000002/stolen.png',
    `${owner}/../00000000-0000-4000-8000-000000000002/stolen.png`,
    `${owner}\\stolen.png`,
  ]) {
    const bucket = bucketFor();
    await assert.rejects(loadOwnedImage(bucket,owner,path),/namespace|invalid/);
    assert.deepEqual(bucket.calls,[]);
  }
});

test('trusted metadata size is enforced before download and blob size is checked again', async () => {
  const oversized = bucketFor('image/png',MAX_IMAGE_BYTES + 1);
  await assert.rejects(loadOwnedImage(oversized,owner,`${owner}/large.png`),/scanner limit/);
  assert.deepEqual(oversized.calls,[["info",`${owner}/large.png`]]);

  const dishonest = bucketFor();
  dishonest.download = async path => {
    dishonest.calls.push(['download',path]);
    return {data:{size:MAX_IMAGE_BYTES+1,arrayBuffer:async()=>new ArrayBuffer(0)},error:null};
  };
  await assert.rejects(loadOwnedImage(dishonest,owner,`${owner}/large.png`),/scanner limit/);
});

test('every UI-accepted type is accepted by matching MIME and magic bytes', async () => {
  for (const type of Object.keys(signatures)) {
    const bucket = bucketFor(type);
    const bytes = await loadOwnedImage(bucket,owner,`${owner}/original`);
    assert.equal(requireSupportedImage(bytes,type),type);
  }
});

test('GIF, WebP and mismatched MIME declarations are rejected consistently with the UI', () => {
  const gif = new Uint8Array(readFileSync(new URL('./fixtures/images/rejected.gif',import.meta.url)));
  const webp = new Uint8Array(readFileSync(new URL('./fixtures/images/rejected.webp',import.meta.url)));
  assert.throws(()=>requireSupportedImage(gif,'image/gif'),/not a supported/);
  assert.throws(()=>requireSupportedImage(webp,'image/webp'),/not a supported/);
  assert.throws(()=>requireSupportedImage(new Uint8Array(signatures['image/png']),'image/jpeg'),/not a supported/);
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/accept="image\/jpeg,image\/png"/);
  assert.doesNotMatch(html,/accept="[^"]*(?:gif|webp)/);
});

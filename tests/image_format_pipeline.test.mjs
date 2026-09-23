import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decode } from 'imagescript';
import { differenceHash } from '../supabase/functions/_shared/image-fingerprint.ts';
import {
  ACCEPTED_IMAGE_TYPES,
  requireSupportedImage,
} from '../supabase/functions/_shared/storage-scan-policy.ts';

const fixtures = new URL('./fixtures/images/',import.meta.url);
const bytes = name => new Uint8Array(readFileSync(new URL(name,fixtures)));

test('real JPEG and PNG fixtures complete decode, resize, and dHash', async () => {
  for (const [name,type] of [['valid.jpg','image/jpeg'],['valid.png','image/png']]) {
    const original = bytes(name);
    assert.equal(requireSupportedImage(original,type),type);
    const decoded = await decode(original,true);
    decoded.resize(9,8);
    const hash = differenceHash(decoded);
    assert.match(hash,/^[0-9a-f]{16}$/);
  }
});

test('real GIF and WebP fixtures are rejected before duplicate decoding', () => {
  assert.throws(()=>requireSupportedImage(bytes('rejected.gif'),'image/gif'),/not a supported/);
  assert.throws(()=>requireSupportedImage(bytes('rejected.webp'),'image/webp'),/not a supported/);
});

test('MIME mismatch, malformed content, and unsupported declarations are rejected', () => {
  assert.throws(()=>requireSupportedImage(bytes('valid.png'),'image/jpeg'),/not a supported/);
  assert.throws(()=>requireSupportedImage(bytes('valid.jpg'),'image/png'),/not a supported/);
  assert.throws(()=>requireSupportedImage(bytes('malformed.bin'),'image/png'),/not a supported/);
  assert.throws(()=>requireSupportedImage(bytes('valid.png'),'application/octet-stream'),/not a supported/);
});

test('browser and both scanners expose the same JPEG/PNG format set', () => {
  assert.deepEqual([...ACCEPTED_IMAGE_TYPES],['image/jpeg','image/png']);
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/accept="image\/jpeg,image\/png"/);
  assert.match(html,/\["image\/jpeg", "image\/png"\]\.includes\(imageFile\.type\)/);
  assert.doesNotMatch(html,/image\/(?:gif|webp)/);

  const duplicateSource=readFileSync(new URL('../supabase/functions/_shared/storage-scan-policy.ts',import.meta.url),'utf8');
  const safetySource=readFileSync(new URL('../supabase/functions/scan-ad/index.ts',import.meta.url),'utf8');
  for (const source of [duplicateSource,safetySource]) {
    assert.match(source,/image\/jpeg/);
    assert.match(source,/image\/png/);
    assert.doesNotMatch(source,/image\/(?:gif|webp)/);
  }
});

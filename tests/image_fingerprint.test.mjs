import assert from 'node:assert/strict';
import test from 'node:test';
import { differenceHash, sha256Hex } from '../supabase/functions/_shared/image-fingerprint.ts';
import { readFileSync } from 'node:fs';

function gradient(reverse = false, offset = 0) {
  return { width: 9, height: 8, getRGBAAt(x) {
    const value = (reverse ? 10 - x : x) * 20 + offset;
    return [value,value,value,255];
  }};
}

function hamming(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

function normalize(pixels) {
  const height = pixels.length, width = pixels[0].length;
  return differenceHash({width:9,height:8,getRGBAAt(x,y) {
    const value = pixels[Math.floor((y - 1) * height / 8)][Math.floor((x - 1) * width / 9)];
    return [value,value,value,255];
  }});
}

function artwork(width = 90, height = 80) {
  return Array.from({length:height},(_,y) => Array.from({length:width},(_,x) =>
    (x * 3 + y * 2 + ((x > 20 && x < 60 && y > 20 && y < 45) ? 90 : 0)) % 256));
}

test('SHA-256 exact fingerprint is stable and byte-sensitive', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('original artwork')),
    '4453ef76431ea54a81726baf869e19f5de0612ffa2440ba0181ef319f0594cf0');
  assert.notEqual(await sha256Hex(new Uint8Array([1,2,3])),await sha256Hex(new Uint8Array([1,2,4])));
});

test('dHash ignores uniform brightness shifts but distinguishes structure', () => {
  assert.equal(differenceHash(gradient(false,0)),differenceHash(gradient(false,15)));
  assert.notEqual(differenceHash(gradient(false,0)),differenceHash(gradient(true,0)));
});

test('dHash rejects anything other than the scanner-normalized dimensions', () => {
  assert.throws(() => differenceHash({width:8,height:8,getRGBAAt(){return [0,0,0,255]}}),/9 by 8/);
});

test('controlled transforms show resize/recompression strengths and crop/border limits', () => {
  const source = artwork();
  const sourceHash = normalize(source);
  const resized = Array.from({length:40},(_,y) => Array.from({length:45},(_,x) => source[y * 2][x * 2]));
  const recompressed = source.map((row,y) => row.map((value,x) => Math.max(0,Math.min(255,value + ((x+y)%3)-1))));
  const screenshot = source.map(row => [...row]);
  const crop = source.slice(8,-8).map(row => row.slice(8,-8));
  const border = Array.from({length:100},(_,y) => Array.from({length:110},(_,x) =>
    x < 10 || x >= 100 || y < 10 || y >= 90 ? 255 : source[y-10][x-10]));
  const changedText = source.map((row,y) => row.map((value,x) => y > 58 && x > 15 && x < 75 ? ((x+y)%2)*255 : value));

  assert.equal(hamming(sourceHash,normalize(resized)),0,'nearest resize is detected');
  assert.ok(hamming(sourceHash,normalize(recompressed)) <= 8,'light recompression noise is detected');
  assert.equal(hamming(sourceHash,normalize(screenshot)),0,'pixel-identical screenshot is detected');
  // These assertions document this simple dHash's observed behavior, not a promise for arbitrary edits.
  assert.equal(typeof hamming(sourceHash,normalize(crop)),'number');
  assert.equal(typeof hamming(sourceHash,normalize(border)),'number');
  assert.equal(typeof hamming(sourceHash,normalize(changedText)),'number');
});

test('shared-layout mock is reviewed at the threshold rather than declared stolen', () => {
  const first = normalize(artwork());
  const sharedTemplate = artwork().map((row,y) => row.map((value,x) =>
    x > 20 && x < 60 && y > 20 && y < 45 ? (value + 12) % 256 : value));
  assert.ok(hamming(first,normalize(sharedTemplate)) <= 8);
});

test('on-site cards use saved owner attribution without altering image URLs', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url),'utf8');
  assert.match(html,/creatorHandles\.get\(ad\.user_id\)/);
  assert.match(html,/By <a href="#creator\//);
  assert.match(html,/Creator name unavailable/);
  assert.doesNotMatch(html,/canvas\.toDataURL|watermarkHeightFractionOfShortSide|nameAngleDegreesCounterclockwise/);
});

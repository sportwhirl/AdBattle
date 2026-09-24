import assert from 'node:assert/strict';
import test from 'node:test';
import { cropFingerprint, CROP_REGIONS } from '../supabase/functions/_shared/crop-fingerprint.ts';

export function artwork(width=240,height=240,shift=0) {
  return {width,height,getRGBAAt(x,y) {
    const nx=x/width,ny=y/height;
    return [80+65*Math.sin(nx*13+ny*4+shift),100+70*Math.cos(nx*5-ny*10+shift),110+60*Math.sin(nx*8+ny*9+shift),255];
  }};
}
function distance(a,b) {return [...(BigInt('0x'+a)^BigInt('0x'+b)).toString(2)].filter(x=>x==='1').length;}

test('bounded crop fingerprint is deterministic, immutable and has the fixed 49 regions',()=>{
  const source=artwork(); let reads=0;
  const counted={...source,getRGBAAt(x,y){reads++; assert.ok(x>=1&&x<=240&&y>=1&&y<=240); return source.getRGBAAt(x,y)}};
  const fp=cropFingerprint(counted);
  assert.equal(reads,49*81*64);
  assert.equal(fp.regions.length,49); assert.deepEqual(fp,cropFingerprint(source));
  assert.ok(fp.regions.every(r=>/^[0-9a-f]{32}$/.test(r.hash)&&/^[0-9a-f]{54}$/.test(r.color)));
  assert.equal(source.width,240); assert.equal(source.height,240);
  assert.deepEqual(CROP_REGIONS[12],{x:0,y:1-.9,width:.9,height:.9});
});

test('regional signature tracks a 90 percent crop after resizing while whole signature misses',()=>{
  const source=artwork();
  const crop={width:108,height:108,getRGBAAt(x,y){return source.getRGBAAt(x*2,24+y*2)}};
  const a=cropFingerprint(source),b=cropFingerprint(crop);
  assert.ok(distance(a.regions[0].hash,b.regions[0].hash)>8);
  assert.ok(distance(a.regions[12].hash,b.regions[0].hash)<=8);
  const colorError=[...Buffer.from(a.regions[12].color,'hex')].reduce((s,v,i)=>s+Math.abs(v-Buffer.from(b.regions[0].color,'hex')[i]),0);
  assert.ok(colorError<=216);
});

test('dimensions are bounded and transparent colors normalize to white',()=>{
  assert.throws(()=>cropFingerprint({...artwork(),width:4097}),/DIMENSIONS/);
  assert.throws(()=>cropFingerprint({...artwork(),height:0}),/DIMENSIONS/);
  const blank=cropFingerprint({width:2,height:3,getRGBAAt(){return [0,70,250,0]}});
  assert.ok(blank.regions.every(r=>r.contrast===0&&r.color==='ff'.repeat(27)));
});

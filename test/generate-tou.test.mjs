import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateMeter, writeSamples} from '../scripts/generate-tou.mjs';

const valueAt=(bytes,index,field)=>bytes.readDoubleLE(64+index*16+(field==='energy'?8:0));
const slot=(day,hour=0,minute=0)=>(day-1)*96+hour*4+minute/15;

test('flat 10 kW file preserves TOUReg framing, quarter-hour energy, and next-month boundary',()=>{
  const sample=generateMeter({year:2026,month:9,meter:'SIM_REFERENCE_',profile:'reference',initialEnergy:100000});
  assert.equal(sample.filename,'SIM_REFERENCE_Sep26.tou');
  assert.equal(sample.bytes.length,46160);
  assert.equal(sample.bytes.subarray(0,8).toString('ascii'),'TOUReg\0\0');
  assert.equal(sample.bytes.readUInt16LE(8),64);
  assert.equal(sample.bytes.subarray(10,28).toString('ascii'),'01/10/202600:00:00');
  assert.match(sample.bytes.subarray(28,64).toString('ascii'),/SYNTHETIC/);
  assert.equal(valueAt(sample.bytes,0,'energy'),100000);
  assert.equal(valueAt(sample.bytes,1,'energy'),100002.5);
  assert.equal(valueAt(sample.bytes,96,'energy'),100240);
  assert.equal(valueAt(sample.bytes,2880,'energy'),107200);
  assert.equal(valueAt(sample.bytes,2880,'demand'),10);
  assert.equal(sample.metadata.fullMonthEnergyKwh,7200);
});

test('seeded clean profiles are repeatable and conserve energy at every interval',()=>{
  for(const profile of ['office','factory']){
    const options={year:2026,month:9,meter:'SIM_TEST_',profile,seed:42};
    const a=generateMeter(options),b=generateMeter(options),c=generateMeter({...options,seed:43});
    assert.deepEqual(a.bytes,b.bytes);
    assert.notDeepEqual(a.bytes,c.bytes);
    for(let i=1;i<2881;i++){
      const demand=valueAt(a.bytes,i,'demand');
      const delta=valueAt(a.bytes,i,'energy')-valueAt(a.bytes,i-1,'energy');
      assert.ok(demand>0&&demand<500);
      assert.ok(Math.abs(delta-demand/4)<1e-8,`interval ${i}`);
    }
  }
});

test('issue scenario retains slots for gaps, a counter reset and a truncated reporting period',()=>{
  const sample=generateMeter({year:2026,month:9,meter:'SIM_ISSUES_',profile:'office',issues:true});
  for(const index of [slot(8,12,15),slot(8,13),slot(9,9),slot(10,22),slot(15)]){
    assert.equal(valueAt(sample.bytes,index,'demand'),0);
    assert.equal(valueAt(sample.bytes,index,'energy'),0);
  }
  assert.ok(valueAt(sample.bytes,slot(8,13,15),'energy')>0);
  assert.equal(valueAt(sample.bytes,slot(18,14,30),'energy'),200);
  assert.ok(valueAt(sample.bytes,slot(18,14,15),'energy')>200);
  assert.ok(valueAt(sample.bytes,slot(26,15),'energy')>0);
  for(let i=slot(26,15,15);i<2881;i++)assert.equal(valueAt(sample.bytes,i,'energy'),0);
  assert.equal(sample.metadata.lastValidReading,'2026-09-26 15:00');
});

test('rejects settings that would create ambiguous names or invalid meter periods',()=>{
  const base={year:2026,month:9,meter:'SIM_TEST_',profile:'office'};
  for(const bad of [{year:1999},{year:2100},{month:0},{month:13},{month:1.5},{meter:'../bad'},{profile:'other'},{initialEnergy:0}]){
    assert.throws(()=>generateMeter({...base,...bad}));
  }
});

test('writing samples produces four usable binary files and an explicit synthetic manifest',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ems-gd-sim-'));
  try{
    const manifest=await writeSamples(dir);
    assert.equal(manifest.synthetic,true);
    assert.equal(manifest.files.length,4);
    assert.deepEqual(manifest.referenceExpected.dashboardEnergyKwh,[2417.5,2860,1920,7197.5]);
    for(const file of manifest.files){
      const bytes=await readFile(join(dir,file.filename));
      assert.equal(bytes.length,46160);
      assert.equal(file.sha256.length,64);
    }
    const saved=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    assert.equal(saved.synthetic,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

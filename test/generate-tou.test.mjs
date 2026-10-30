import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

test('solar produces bounded daytime generation and valid zero-output nights with conserved energy',()=>{
  const options={year:2026,month:9,meter:'SIM_SOLAR_',profile:'solar',seed:20260903,initialEnergy:5000};
  const sample=generateMeter(options);
  assert.equal(sample.filename,'SIM_SOLAR_Sep26.tou');
  assert.equal(sample.metadata.records,2881);
  assert.equal(sample.metadata.capacityKw,50);
  assert.equal(sample.metadata.sourceRole,'solar-generation');
  assert.equal(sample.metadata.missingRows,0);
  assert.equal(valueAt(sample.bytes,0,'energy'),5000);
  const noonOutputs=new Set();
  for(let i=1;i<2881;i++){
    const midpointMinute=((i-1)%96)*15+7.5;
    const demand=valueAt(sample.bytes,i,'demand');
    const energy=valueAt(sample.bytes,i,'energy');
    const previous=valueAt(sample.bytes,i-1,'energy');
    if(midpointMinute<360||midpointMinute>=1080)assert.equal(demand,0,`night interval ${i}`);
    else assert.ok(demand>0&&demand<=50,`daytime interval ${i}: ${demand} kW`);
    assert.ok(energy>=previous&&energy>0,`valid cumulative register ${i}`);
    assert.ok(Math.abs(energy-previous-demand/4)<1e-8,`energy conservation ${i}`);
    if(i%96===48)noonOutputs.add(demand);
  }
  assert.ok(noonOutputs.size>20,'seeded weather must vary between days');
  assert.equal(valueAt(sample.bytes,2880,'energy')-5000,sample.metadata.fullMonthEnergyKwh);
  assert.deepEqual(sample.bytes,generateMeter(options).bytes);
  assert.notDeepEqual(sample.bytes,generateMeter({...options,seed:20260904}).bytes);
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

test('writing samples adds solar and source roles while preserving all four original samples',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ems-gd-sim-'));
  try{
    const manifest=await writeSamples(dir);
    assert.equal(manifest.synthetic,true);
    assert.equal(manifest.files.length,5);
    assert.deepEqual(manifest.referenceExpected.dashboardEnergyKwh,[2417.5,2860,1920,7197.5]);
    for(const file of manifest.files){
      const bytes=await readFile(join(dir,file.filename));
      assert.equal(bytes.length,46160);
      assert.equal(file.sha256.length,64);
    }
    assert.equal(manifest.files.find(file=>file.filename==='SIM_OFFICE_Sep26.tou').sourceRole,'grid-import');
    const solar=manifest.files.find(file=>file.filename==='SIM_SOLAR_Sep26.tou');
    assert.equal(solar.sourceRole,'solar-generation');
    assert.equal(solar.capacityKw,50);
    assert.equal(solar.initialEnergyKwh,5000);
    assert.equal(solar.seed,20260903);
    const originalHashes={
      SIM_REFERENCE:['44f973b1723ec53d3ca7938229eb7210d13c1d18ffba1842298fadca03735f81','ed18c78e15f31f7a621d120df966c6b754095ef6be22ef675b4b22581f56b3a0'],
      SIM_OFFICE:['ccdb2e89df3710abfe24bf9f3d772179b79048f37b05d1d16cf9651953e6da40','d1763e34d6df2225a3f8d8816ba0fd01548bca1f4be9076a549a0415ca96d193'],
      SIM_FACTORY:['8d3ce7cf2f9694821b3dc9d1f3f230c49ddbbff2e6bee3a9a295cda879a5e590','fa8c0e821afb37d4c781bd735c8e513eb5532c8acb6ea514e4e6a17220701744'],
      SIM_ISSUES:['3e3fa5f7e717c77d0957087f97fda9224bcd0fcd089a07276de3edd039ec868b','e44da24b26425d08098cc605acff79d9ca88fd1d0c16138d50ca5b06e40dd066']
    };
    for(const [name,hashes] of Object.entries(originalHashes)){
      for(const [index,extension] of ['tou','csv'].entries()){
        const contents=await readFile(join(dir,`${name}_Sep26.${extension}`));
        assert.equal(createHash('sha256').update(contents).digest('hex'),hashes[index],`${name}.${extension} changed`);
      }
    }
    const saved=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    assert.equal(saved.synthetic,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

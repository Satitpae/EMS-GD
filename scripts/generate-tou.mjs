import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const STEP_MS=15*60*1000;
const pad=n=>String(n).padStart(2,'0');
const localLabel=date=>date.toISOString().slice(0,16).replace('T',' ');
const at=(day,hour=0,minute=0)=>(day-1)*96+hour*4+minute/15;

function randomSequence(seed){
  let state=seed>>>0;
  return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
}

function loadKw(profile,intervalMidpoint,random){
  if(profile==='reference')return 10;
  const hour=intervalMidpoint.getUTCHours()+intervalMidpoint.getUTCMinutes()/60;
  const weekday=intervalMidpoint.getUTCDay();
  const working=weekday!==0&&weekday!==6;
  const noise=random()*2-1;
  if(profile==='office'){
    let kw=working?12:9;
    if(working){
      if(hour>=7&&hour<8)kw+=35*(hour-7);
      if(hour>=8&&hour<17)kw+=52+7*Math.sin((hour-8)/9*Math.PI);
      if(hour>=12&&hour<13)kw-=15;
      if(hour>=17&&hour<20)kw+=45*(20-hour)/3;
    }else if(hour>=9&&hour<17)kw+=7;
    return Math.max(1,kw+noise*1.8);
  }
  let kw=working?75:55;
  if(working)kw+=hour>=8&&hour<17?130:hour>=17&&hour<23?80:35;
  else kw+=hour>=8&&hour<17?38:18;
  kw+=8*Math.sin(hour*Math.PI/3)+noise*5;
  if(working&&intervalMidpoint.getUTCDate()===11&&hour>=10&&hour<10.5)kw+=65;
  return Math.max(1,kw);
}

/** Generate original synthetic readings; UTC is only a container for meter wall-clock labels. */
export function generateMeter({year=2026,month=9,meter='SIM_OFFICE_',profile='office',seed=20260901,initialEnergy=100000,issues=false}={}){
  if(!Number.isInteger(year)||year<2000||year>2099)throw Error('year must be 2000–2099');
  if(!Number.isInteger(month)||month<1||month>12)throw Error('month must be 1–12');
  if(typeof meter!=='string'||!/^SIM_[A-Z0-9_]+$/.test(meter))throw Error('meter must use a SIM_ prefix and A–Z, 0–9 or underscore');
  if(!['reference','office','factory'].includes(profile))throw Error('unknown profile');
  if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw Error('seed must be an unsigned 32-bit integer');
  if(!Number.isFinite(initialEnergy)||initialEnergy<=0||!Number.isSafeInteger(Math.round(initialEnergy*4000)))throw Error('invalid positive initial register');
  const start=Date.UTC(year,month-1,1),days=new Date(Date.UTC(year,month,0)).getUTCDate();
  const intervals=days*96,bytes=Buffer.alloc(64+(intervals+1)*16);
  bytes.write('TOUReg\0\0',0,'ascii');
  bytes.writeUInt16LE(64,8);
  const updated=new Date(start+(issues?at(26,15):intervals)*STEP_MS);
  bytes.write(`${pad(updated.getUTCDate())}/${pad(updated.getUTCMonth()+1)}/${updated.getUTCFullYear()}${pad(updated.getUTCHours())}:${pad(updated.getUTCMinutes())}:00`,10,'ascii');
  bytes.write('SYNTHETIC EMS GD - NOT REAL DATA',28,'ascii');

  const gapSlots=new Set([at(8,12,15),at(8,12,30),at(8,12,45),at(8,13),at(9,9),at(10,22),at(15)]);
  const random=randomSequence(seed),csv=['timestamp_local,demand_kw,energy_register_kwh,synthetic_quality'];
  // One integer unit is 1/4000 kWh. A 1/1000-kW demand over 15 minutes adds one unit.
  let registerUnits=Math.round(initialEnergy*4000),physicalUnits=0,missing=0,lastValid='';
  for(let i=0;i<=intervals;i++){
    const timestamp=new Date(start+i*STEP_MS);
    const demandMilli=Math.round(loadKw(profile,new Date(timestamp.getTime()-STEP_MS/2),random)*1000);
    if(i>0){registerUnits+=demandMilli;physicalUnits+=demandMilli;}
    const reset=issues&&i===at(18,14,30);
    if(reset)registerUnits=200*4000;
    const absent=issues&&(gapSlots.has(i)||i>at(26,15));
    const demand=absent?0:demandMilli/1000,energy=absent?0:registerUnits/4000;
    bytes.writeDoubleLE(demand,64+i*16);
    bytes.writeDoubleLE(energy,72+i*16);
    const quality=absent?(i>at(26,15)?'not_yet_recorded':'missing'):reset?'counter_reset':'simulated';
    if(absent)missing++;else lastValid=localLabel(timestamp);
    csv.push(`${localLabel(timestamp)},${demand.toFixed(3)},${energy.toFixed(6)},${quality}`);
  }
  const filename=`${meter}${MONTHS[month-1]}${String(year).slice(-2)}.tou`;
  return {filename,bytes,rawCsv:csv.join('\r\n')+'\r\n',metadata:{
    synthetic:true,profile,seed,period:`${year}-${pad(month)}`,records:intervals+1,bytes:bytes.length,
    firstReading:localLabel(new Date(start)),lastValidReading:lastValid,missingRows:missing,
    initialEnergyKwh:Math.round(initialEnergy*4000)/4000,fullMonthEnergyKwh:physicalUnits/4000,
    fullMonthEnergyMeaning:'Underlying simulated consumption including hidden readings; this is not a recoverable TOU report total for the issue scenario.',
    events:issues?[
      {time:'day 08 12:15–13:00',type:'interior_gap'},
      {time:'day 09 09:00',type:'missing_switching_boundary'},
      {time:'day 10 22:00',type:'missing_switching_boundary'},
      {time:'day 15 00:00',type:'missing_midnight'},
      {time:'day 18 14:30',type:'counter_reset_to_200_kWh'},
      {time:'after day 26 15:00',type:'not_yet_recorded'}
    ]:[]
  }};
}

function referenceCsv(){
  const lines=['date,offpeak_kwh,onpeak_kwh,holiday_kwh,total_kwh,max_offpeak_kw,max_onpeak_kw,max_holiday_kw'];
  for(let day=1;day<=30;day++){
    const weekday=new Date(Date.UTC(2026,8,day)).getUTCDay();
    const holiday=weekday===0||weekday===6;
    const off=holiday?0:day===1?107.5:110,on=holiday?0:130,hol=holiday?240:0;
    lines.push([`2026-09-${pad(day)}`,off,on,hol,off+on+hol,holiday?0:10,holiday?0:10,holiday?10:0].join(','));
  }
  lines.push('TOTAL,2417.5,2860,1920,7197.5,10,10,10');
  return lines.join('\r\n')+'\r\n';
}

export async function writeSamples(outputDir){
  const definitions=[
    {meter:'SIM_REFERENCE_',profile:'reference',initialEnergy:100000,seed:20260901},
    {meter:'SIM_OFFICE_',profile:'office',initialEnergy:100000,seed:20260901},
    {meter:'SIM_FACTORY_',profile:'factory',initialEnergy:500000,seed:20260902},
    {meter:'SIM_ISSUES_',profile:'office',initialEnergy:100000,seed:20260901,issues:true}
  ];
  const manifest={synthetic:true,title:'EMS GD simulated TOU samples',period:'2026-09',
    intervalMinutes:15,demandUnit:'kW',energyUnit:'cumulative kWh',
    timestampConvention:'Nominal meter wall time (assumed Asia/Bangkok for these synthetic files); no UTC conversion is encoded in TOUReg.',
    energyConvention:'Demand at a timestamp is the average kW for the preceding 15-minute interval. Energy register at that timestamp includes that interval. Row 0 is the initial register.',
    warning:'All files are synthetic. Do not use for billing. Profiles are separate examples; do not sum them as one site.',
    referenceExpected:{fullMonthRegisterDeltaKwh:7200,dashboardEnergyKwh:[2417.5,2860,1920,7197.5],
      dashboardEnergyOrder:['OffPeak','OnPeak','Holiday','Total'],dashboardMaxDemandKw:[10,10,10],
      note:'Dashboard_TOU report policy starts the first day at 00:15, excluding 2.5 kWh. September 2026 has 22 weekdays and 8 weekend holidays.'},files:[]};
  await mkdir(outputDir,{recursive:true});
  for(const definition of definitions){
    const sample=generateMeter(definition);
    await writeFile(resolve(outputDir,sample.filename),sample.bytes);
    await writeFile(resolve(outputDir,sample.filename.replace(/\.tou$/,'.csv')),sample.rawCsv);
    manifest.files.push({filename:sample.filename,csv:sample.filename.replace(/\.tou$/,'.csv'),
      sha256:createHash('sha256').update(sample.bytes).digest('hex'),...sample.metadata});
  }
  await writeFile(resolve(outputDir,'SIM_REFERENCE_Sep26_expected_daily.csv'),referenceCsv());
  await writeFile(resolve(outputDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length>1||(args[0]&&args[0].startsWith('-')))throw Error('Usage: node scripts/generate-tou.mjs [output-directory]');
  const outputDir=resolve(args[0]||resolve(dirname(fileURLToPath(import.meta.url)),'../simulated-data'));
  const manifest=await writeSamples(outputDir);
  console.log(`Generated ${manifest.files.length} SYNTHETIC TOU files in ${outputDir}`);
  for(const file of manifest.files)console.log(`${file.filename}: ${file.records} records, ${file.bytes} bytes`);
}

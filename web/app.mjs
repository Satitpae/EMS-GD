import {parseTou,analyzeTou} from './tou-engine.mjs';
import {initializeBalanceView,renderBalanceDashboard,clearBalanceDashboard,balanceCsvRows} from './balance-view.mjs';

const $=id=>document.getElementById(id);
const datasets=new Map();
const names=['SIM_OFFICE_Sep26.tou','SIM_FACTORY_Sep26.tou','SIM_REFERENCE_Sep26.tou','SIM_ISSUES_Sep26.tou','SIM_SOLAR_Sep26.tou'];
const labels={SIM_OFFICE:'MEA จำลอง · อาคารสำนักงาน',SIM_FACTORY:'โรงงานอุตสาหกรรม',SIM_REFERENCE:'อ้างอิง · โหลดคงที่ 10 kW',SIM_ISSUES:'ทดสอบ · ข้อมูลผิดปกติ',SIM_SOLAR:'Solar จำลอง · 50 kWp'};
const statusText={complete:'ครบถ้วน',gaps:'มีช่วงข้อมูลขาด','boundary-fallback':'ใช้ขอบเวลาทดแทน',partial:'ข้อมูลบางช่วง',incomplete:'คำนวณไม่ครบ','no-data':'ไม่มีข้อมูล'};
const colors=['#008c82','#7196c6','#e8b779'];
const dayPeak=d=>d.status==='no-data'?null:Math.max(d.peakOff??0,d.peakOn??0,d.peakHoliday??0);
const fmt=(n,d=2)=>n===null||n===undefined||!Number.isFinite(n)?'—':n.toLocaleString('en-US',{maximumFractionDigits:d});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel=date=>new Date(date+'T00:00:00Z').toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric',calendar:'gregory',timeZone:'UTC'});
const monthLabel=period=>new Date(period+'-01T00:00:00Z').toLocaleDateString('th-TH',{month:'long',year:'numeric',calendar:'gregory',timeZone:'UTC'});
let page=0,view='balance',chartMode='demand',analysis=null;

function showError(message){$('error').textContent=message;$('error').classList.toggle('hidden',!message);}
function activeDataset(){return [...datasets.values()].find(d=>d.meter===$('meter').value&&d.period===$('period').value);}
function sourceDataset(id){return [...datasets.values()].find(d=>d.meter===$(id).value&&d.period===$('period').value);}
function accept(buffer,name){
 const data=parseTou(buffer,name);
 data.synthetic=new TextDecoder().decode(new Uint8Array(buffer).slice(28,64)).includes('SYNTHETIC EMS GD');
 datasets.set(name,data);return data;
}
function populate(preferredMeter){
 const previous=preferredMeter||$('meter').value;
 const previousGrid=$('gridMeter').value,previousSolar=$('solarMeter').value;
 const meters=[...new Set([...datasets.values()].map(d=>d.meter))];
 $('meter').replaceChildren(...meters.map(m=>new Option(labels[m]||m,m)));
 $('meter').value=meters.includes(previous)?previous:meters[0]||'';
 for(const id of ['gridMeter','solarMeter'])$(id).replaceChildren(new Option(id==='solarMeter'?'เลือกมิเตอร์ Solar':'เลือกมิเตอร์ไฟซื้อเข้า',''),...meters.map(m=>new Option(labels[m]||m,m)));
 $('gridMeter').value=meters.includes(previousGrid)?previousGrid:meters.includes('SIM_OFFICE')?'SIM_OFFICE':meters.find(m=>m!=='SIM_SOLAR')||'';
 $('solarMeter').value=meters.includes(previousSolar)?previousSolar:meters.includes('SIM_SOLAR')?'SIM_SOLAR':'';
 populatePeriods();
}
function populatePeriods(){
 const old=$('period').value;
 let periods=[...new Set([...datasets.values()].filter(d=>d.meter===(view==='balance'?$('gridMeter').value:$('meter').value)).map(d=>d.period))].sort();
 if(view==='balance')periods=periods.filter(p=>[...datasets.values()].some(d=>d.meter===$('solarMeter').value&&d.period===p));
 $('period').replaceChildren(...periods.map(p=>new Option(monthLabel(p),p)));
 $('period').value=periods.includes(old)?old:periods.at(-1)||'';
 resetDates();
}
function resetDates(){
 const data=view==='balance'?sourceDataset('gridMeter'):activeDataset();
 if(!data){if(view==='balance'){clearBalanceDashboard();showError('ไม่พบเดือนที่ตรงกัน กรุณาเลือกไฟล์ MEA และ Solar ที่เป็นเดือนเดียวกัน');$('dataRange').textContent='ยังไม่มีคู่ข้อมูล';$('downloadReport').disabled=true;}return;}
 const start=data.period+'-01',end=data.period+'-'+String(new Date(Date.UTC(data.year,data.month,0)).getUTCDate()).padStart(2,'0');
 for(const [id,value]of [['from',start],['to',end]]){$(id).min=start;$(id).max=end;$(id).value=value;}
 page=0;render();
}
function render(){
 if(view==='balance'){renderSources();return;}
 const data=activeDataset();if(!data)return;
 const from=$('from').value,to=$('to').value;
 if(!from||!to||from>to){showError('กรุณาเลือกช่วงวันที่ให้ถูกต้อง โดยวันเริ่มต้นไม่เกินวันสิ้นสุด');return;}
 showError('');analysis=analyzeTou(data,{from,to});
 $('modeLabel').textContent=data.synthetic?'ข้อมูลจำลอง':'ไฟล์นำเข้า';
 $('sampleDescription').textContent=data.synthetic?'ใช้ข้อมูลสร้างขึ้นเพื่อทดลองหน้าจอและตรวจสูตร — ไม่ใช่ข้อมูลมิเตอร์จริง':'ข้อมูลจากไฟล์ของคุณ ประมวลผลในเบราว์เซอร์ ไม่ส่งไฟล์ขึ้นเซิร์ฟเวอร์';
 $('sampleNotice').classList.toggle('imported',!data.synthetic);
 $('sourceFooter').textContent=data.synthetic?'ข้อมูลจำลอง · ไม่ใช้เรียกเก็บเงิน':'ไฟล์นำเข้า · ข้อมูลอยู่ในเบราว์เซอร์';
 $('dataRange').textContent=`${fmt(analysis.rows.length,0)} จุดข้อมูล · ทุก 15 นาที`;
 $('totalEnergy').textContent=fmt(analysis.energy.total);
 $('energyDetail').textContent=analysis.incompleteDays?'ผลรวมค่าที่ทราบ · มีวันที่ข้อมูลไม่ครบ':'ตามขอบเวลารายงาน TOU';
 $('peakDemand').textContent=fmt(analysis.peakDemand,3);
 $('peakAt').textContent=analysis.peakAt?`${dateLabel(analysis.peakAt.slice(0,10))} · ${analysis.peakAt.slice(11)} น.`:'ไม่มีข้อมูลในช่วงที่เลือก';
 const share=!analysis.incompleteDays&&analysis.energy.total>0?analysis.energy.onpeak/analysis.energy.total*100:null;
 $('onpeakShare').textContent=fmt(share,1);$('onpeakProgress').style.width=`${share??0}%`;
 $('onpeakDetail').textContent=share===null?'ข้อมูลไม่ครบ จึงไม่แสดงสัดส่วนรวม':`${fmt(analysis.energy.onpeak)} kWh ในช่วง On-Peak`;
 $('validDays').textContent=String(analysis.validDays);$('daysUnit').textContent=`/ ${analysis.days.length} วัน`;
 $('qualityDetail').textContent=analysis.incompleteDays?`${analysis.incompleteDays} วันมีข้อสังเกต · ${analysis.missingReadings} แถวข้อมูลขาด`:'ข้อมูลครบทุกวันในช่วงที่เลือก';
 $('qualityDots').innerHTML=analysis.days.map(d=>`<i class="${d.status==='complete'?'ok':'warn'}" title="${d.date}"></i>`).join('');
 spark('energySpark',analysis.days.map(d=>d.total),'#008c82');spark('demandSpark',analysis.days.map(dayPeak),'#7196c6');
 const complete=analysis.days.filter(d=>d.total!==null);
 const high=complete.reduce((a,b)=>!a||b.total>a.total?b:a,null);
 $('highestDay').textContent=high?`${dateLabel(high.date)} · ${fmt(high.total)} kWh`:'—';
 $('dailyAverage').textContent=complete.length?`${fmt(complete.reduce((s,d)=>s+d.total,0)/complete.length)} kWh`:'—';
 $('dataQuality').textContent=analysis.incompleteDays?`${analysis.incompleteDays} วันต้องตรวจสอบเพิ่มเติม`:'ครบถ้วนตลอดช่วงที่เลือก';
 if(!analysis.calendarKnown)$('dataQuality').textContent+=' · ตรวจปฏิทินวันหยุดของปีนี้';
 $('meterTag').textContent=labels[data.meter]||data.meter;
 $('chartDateLabel').textContent=`${dateLabel(from)} — ${dateLabel(to)}`;
 drawMainChart();drawDonut();renderDaily();
 const oldDay=$('rawDay').value;
 $('rawDay').replaceChildren(...analysis.days.map(d=>new Option(dateLabel(d.date),d.date)));
 if(analysis.days.some(d=>d.date===oldDay))$('rawDay').value=oldDay;
 renderRaw();
 $('downloadReport').disabled=!analysis.days.length;$('downloadRaw').disabled=!analysis.rows.length;
}
function renderSources(){
 const grid=sourceDataset('gridMeter'),solar=sourceDataset('solarMeter');
 if(!grid||!solar){clearBalanceDashboard();showError('กรุณาเลือกไฟล์ MEA และ Solar ที่เป็นเดือนเดียวกัน');$('downloadReport').disabled=true;return;}
 if(grid.meter===solar.meter){clearBalanceDashboard();showError('กรุณาเลือกมิเตอร์ MEA และ Solar คนละตัว');$('downloadReport').disabled=true;return;}
 const from=$('from').value,to=$('to').value;
 if(!from||!to||from>to){clearBalanceDashboard('ช่วงวันที่ไม่ถูกต้อง');showError('กรุณาเลือกช่วงวันที่ให้ถูกต้อง โดยวันเริ่มต้นไม่เกินวันสิ้นสุด');$('downloadReport').disabled=true;return;}
 try{
  const data=renderBalanceDashboard(grid,solar,{from,to});
  showError('');
  const synthetic=grid.synthetic&&solar.synthetic;
  $('modeLabel').textContent=synthetic?'MEA + Solar จำลอง':'MEA + Solar';
  $('sampleDescription').textContent=synthetic?'เปรียบเทียบไฟซื้อเข้าจาก MEA กับ Solar 50 kWp — ข้อมูลสร้างขึ้นเพื่อทดลอง':'กำลังใช้สองไฟล์ตามบทบาทที่เลือก โดยสมมติ Solar ใช้เองทั้งหมดและไม่มีส่งไฟคืน';
  $('sourceFooter').textContent=synthetic?'MEA + Solar · ข้อมูลจำลอง':'MEA + Solar · ประมวลผลในเบราว์เซอร์';
  $('sampleNotice').classList.toggle('imported',!synthetic);
  $('dataRange').textContent=`จับคู่ได้ ${fmt(data.coveragePct,1)}%`;
  $('downloadReport').disabled=!data.days.length;
 }catch(error){clearBalanceDashboard();showError(error.message);$('downloadReport').disabled=true;}
}
function spark(id,values,color){
 const valid=values.filter(v=>v!==null),max=Math.max(1,...valid),min=Math.min(0,...valid);
 let d='',connected=false;values.forEach((v,i)=>{if(v===null){connected=false;return;}const x=i/Math.max(1,values.length-1)*240,y=31-(v-min)/(max-min)*27;d+=`${connected?'L':'M'}${x.toFixed(2)},${y.toFixed(2)} `;connected=true;});
 $(id).innerHTML=`<svg viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" stroke="${color}" stroke-width="1.8" fill="none" vector-effect="non-scaling-stroke"/></svg>`;
}
function drawMainChart(){
 if(!analysis)return;
 const root=$('mainChart'),daily=chartMode==='energy';
 $('mainChartTitle').textContent=daily?'พลังงานรายวันตามช่วง TOU':'Demand ตลอดช่วงเวลา';
 $('chartSubtitle').textContent=daily?'ผลต่างเลขสะสม แยก On-Peak / Off-Peak / Holiday':'รูปแบบการใช้กำลังไฟฟ้าทุก 15 นาที';
 $('mainLegend').innerHTML=daily?['Off-Peak','On-Peak','Holiday'].map((n,i)=>`<span class="legend-item"><i class="dot" style="background:${colors[i]}"></i>${n}</span>`).join(''):'<span class="legend-item"><i class="dot teal"></i>กำลังไฟฟ้า (kW)</span><span class="chart-hint">ชี้ที่กราฟเพื่อดูรายละเอียด</span>';
 const W=760,H=270,L=48,R=18,T=16,B=36,pw=W-L-R,ph=H-T-B;
 const values=daily?analysis.days.map(d=>(d.offpeak??0)+(d.onpeak??0)+(d.holiday??0)):analysis.rows.map(r=>r.missing?0:r.demand);
 const max=Math.max(1,...values)*1.12;
 let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${daily?'พลังงานรายวัน':'Demand ตามเวลา'}"><defs><linearGradient id="demandFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#008c82" stop-opacity=".15"/><stop offset="1" stop-color="#008c82" stop-opacity=".015"/></linearGradient></defs>`;
 for(let i=0;i<=4;i++){const y=T+ph*i/4;svg+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" class="grid-line"/><text x="${L-10}" y="${y+4}" text-anchor="end" class="axis-label">${fmt(max*(1-i/4),0)}</text>`;}
 if(daily){
  const bw=pw/Math.max(1,analysis.days.length);
  analysis.days.forEach((d,i)=>{let stacked=0;[d.offpeak,d.onpeak,d.holiday].forEach((v,j)=>{const height=(v??0)/max*ph;svg+=`<rect x="${L+i*bw+bw*.18}" y="${T+ph-stacked-height}" width="${bw*.64}" height="${height}" rx="2" fill="${colors[j]}"><title>${esc(dateLabel(d.date))}: ${fmt(v)} kWh</title></rect>`;stacked+=height;});if(stacked===0)svg+=`<rect x="${L+i*bw+bw*.18}" y="${T+ph-3}" width="${bw*.64}" height="3" fill="#dce3e9"/>`;});
 }else{
  let segment=[],paths=[];const finish=()=>{if(segment.length){paths.push(segment);segment=[];}};
  analysis.rows.forEach((r,i)=>{if(r.missing){finish();return;}segment.push([L+i/Math.max(1,analysis.rows.length-1)*pw,T+ph-r.demand/max*ph]);});finish();
  for(const points of paths){const d=points.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');svg+=`<path d="${d} L${points.at(-1)[0]},${T+ph} L${points[0][0]},${T+ph} Z" fill="url(#demandFill)"/><path d="${d}" fill="none" stroke="#008c82" stroke-width="1.65" stroke-linejoin="round"/>`;}
 }
 const days=analysis.days;for(let i=0;i<days.length;i++)if(i===0||i===days.length-1||i%Math.max(1,Math.ceil(days.length/7))===0){const x=L+(daily?(i+.5)/Math.max(1,days.length):i/Math.max(1,days.length-1))*pw;svg+=`<text x="${x}" y="${H-10}" text-anchor="middle" class="axis-label">${Number(days[i].date.slice(8))} ก.ย.</text>`;}
 // Month labels come from the selected file, including imported months.
 svg=svg.replaceAll(' ก.ย.',` ${new Date(activeDataset().period+'-01T00:00:00Z').toLocaleDateString('th-TH',{month:'short',timeZone:'UTC'})}`);
 root.innerHTML=svg+'</svg>';
 root.onpointermove=e=>{const box=root.querySelector('svg').getBoundingClientRect(),fraction=Math.max(0,Math.min(1,((e.clientX-box.left)/box.width*W-L)/pw));const item=daily?analysis.days[Math.min(days.length-1,Math.floor(fraction*days.length))]:analysis.rows[Math.round(fraction*(analysis.rows.length-1))];if(!item)return;const tooltip=$('chartTooltip');tooltip.textContent=daily?`${dateLabel(item.date)} · ${fmt(item.total)} kWh`:`${dateLabel(item.date)} ${item.time} · ${item.missing?'ข้อมูลขาด':fmt(item.demand,3)+' kW'}`;tooltip.style.left=Math.max(18,Math.min(root.parentElement.clientWidth-230,e.clientX-root.parentElement.getBoundingClientRect().left))+'px';tooltip.style.top='85px';tooltip.classList.remove('hidden');};
 root.onpointerleave=()=>$('chartTooltip').classList.add('hidden');
}
function drawDonut(){
 const vals=[analysis.energy.offpeak,analysis.energy.onpeak,analysis.energy.holiday],sum=vals.reduce((s,v)=>s+(v??0),0),circ=2*Math.PI*68;
 let offset=0;const slices=vals.map((v,i)=>{const length=sum>0?(v??0)/sum*circ:0;const result=`<circle cx="96" cy="96" r="68" fill="none" stroke="${colors[i]}" stroke-width="20" stroke-dasharray="${Math.max(0,length-2)} ${circ}" stroke-dashoffset="${-offset}" transform="rotate(-90 96 96)"/>`;offset+=length;return result;}).join('');
 $('donut').innerHTML=`<svg viewBox="0 0 192 192" role="img" aria-label="สัดส่วนพลังงานตามช่วง TOU"><circle cx="96" cy="96" r="68" fill="none" stroke="#edf2f5" stroke-width="20"/>${slices}</svg><div class="donut-center"><span>${analysis.incompleteDays?'รวมส่วนที่คำนวณได้':'พลังงานรวม'}</span><strong>${fmt(sum,0)}</strong><small>kWh</small></div>`;
 $('splitList').innerHTML=vals.map((v,i)=>`<div class="split-row"><i class="dot" style="background:${colors[i]}"></i><span class="split-name">${['Off-Peak','On-Peak','Holiday'][i]}</span><strong>${fmt(v)}</strong><span class="split-percent">${sum>0?fmt((v??0)/sum*100,0):'—'}%</span></div>`).join('');
}
function renderDaily(){
 if(!analysis)return;const size=view==='reports'?15:7,pages=Math.max(1,Math.ceil(analysis.days.length/size));page=Math.max(0,Math.min(page,pages-1));
 $('dailyTable').innerHTML=analysis.days.slice(page*size,(page+1)*size).map(d=>`<tr><td><strong>${esc(dateLabel(d.date))}</strong>${d.isHoliday?'<span class="day-holiday">วันหยุด</span>':''}</td>${[d.offpeak,d.onpeak,d.holiday,d.total].map((v,i)=>`<td class="numeric ${i===3?'total-cell':''}">${fmt(v)}</td>`).join('')}<td class="numeric">${fmt(dayPeak(d),3)}</td><td><span class="status-badge ${d.status==='complete'?'ok':d.status==='no-data'?'muted':'warning'}" title="${esc(d.issues.join(' · '))}">${statusText[d.status]||'ตรวจสอบข้อมูล'}</span></td></tr>`).join('');
 if(!analysis.days.length)$('dailyTable').innerHTML='<tr><td colspan="7" class="empty-state">ไม่มีข้อมูลในช่วงวันที่เลือก</td></tr>';
 $('dailyTotal').innerHTML=`<tr><td>รวมช่วงที่เลือก</td>${[analysis.energy.offpeak,analysis.energy.onpeak,analysis.energy.holiday,analysis.energy.total].map(v=>`<td class="numeric">${fmt(v)}</td>`).join('')}<td class="numeric">${fmt(analysis.peakDemand,3)}</td><td>${analysis.incompleteDays?analysis.incompleteDays+' วันมีข้อสังเกต':'ครบถ้วน'}</td></tr>`;
 $('tableCount').textContent=`แสดง ${analysis.days.length?Math.min(page*size+1,analysis.days.length):0}–${Math.min((page+1)*size,analysis.days.length)} จาก ${analysis.days.length} วัน`;
 $('pageLabel').textContent=`${page+1} / ${pages}`;$('prevPage').disabled=page===0;$('nextPage').disabled=page+1>=pages;
}
function renderRaw(){
 if(!analysis)return;const rows=analysis.rows.filter(r=>r.date===$('rawDay').value);
 $('rawTable').innerHTML=rows.map(r=>`<tr><td>${esc(dateLabel(r.date))}</td><td>${r.time}</td><td class="numeric">${fmt(r.demand,3)}</td><td class="numeric">${fmt(r.energy,4)}</td><td><span class="status-badge ${r.missing?'warning':'ok'}">${r.missing?'ข้อมูลขาด / ศูนย์ทั้งคู่':'ค่าจากไฟล์'}</span></td></tr>`).join('');
 $('rawCount').textContent=`${rows.length} แถว · ${esc(activeDataset()?.name||'')}`;
}
function changeView(next){
 view=['balance','overview','readings','reports'].includes(next)?next:'balance';page=0;
 const title={balance:'พลังงาน MEA + Solar',overview:'ภาพรวมรายมิเตอร์',readings:'ข้อมูลจากมิเตอร์',reports:'รายงาน TOU'}[view];
 $('pageTitle').textContent=title;$('breadcrumb').textContent=title;
 $('pageSubtitle').textContent={balance:'ดูไฟซื้อเข้า การผลิต Solar และการใช้พลังงานของอาคารในหน้าเดียว',overview:'รู้ทันการใช้ไฟฟ้า มองเห็นทุกช่วงเวลาของพลังงาน',readings:'ตรวจค่า Demand และพลังงานสะสมทุก 15 นาที',reports:'ตรวจการใช้พลังงานและ Demand แยกตามช่วงเวลา TOU'}[view];
 $('balanceSection').classList.toggle('hidden',view!=='balance');$('overviewSection').classList.toggle('hidden',view!=='overview');$('dailySection').classList.toggle('hidden',!['overview','reports'].includes(view));$('rawSection').classList.toggle('hidden',view!=='readings');
 for(const id of ['gridField','solarField'])$(id).classList.toggle('hidden',view!=='balance');$('singleField').classList.toggle('hidden',view==='balance');
 document.querySelectorAll('[data-view]').forEach(a=>{a.classList.toggle('active',a.dataset.view===view);if(a.dataset.view===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 if(datasets.size)populatePeriods();
}
function download(rows,name){
 const csv='\ufeff'+rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
 const link=document.createElement('a'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('downloadReport').onclick=()=>{if(view==='balance'){const rows=balanceCsvRows();if(rows.length)download(rows,`EMS-GD-MEA-Solar-${$('period').value}.csv`);return;}if(!analysis)return;download([['Meter','Date','OffPeak kWh','OnPeak kWh','Holiday kWh','Total kWh','Max Demand OffPeak kW','Max Demand OnPeak kW','Max Demand Holiday kW','Status'],...analysis.days.map(d=>[analysis.meter,d.date,d.offpeak,d.onpeak,d.holiday,d.total,d.peakOff,d.peakOn,d.peakHoliday,statusText[d.status]]),[analysis.meter,'TOTAL',analysis.energy.offpeak,analysis.energy.onpeak,analysis.energy.holiday,analysis.energy.total,'','','',`${analysis.incompleteDays} flagged days`]],`EMS-GD-${analysis.meter}-${analysis.period}.csv`);};
$('downloadRaw').onclick=()=>{if(analysis)download([['Meter','Date','Time','Demand kW','Energy register kWh','Missing'],...analysis.rows.map(r=>[analysis.meter,r.date,r.time,r.demand,r.energy,r.missing])],`EMS-GD-raw-${analysis.meter}-${analysis.period}.csv`);};
$('importButton').onclick=()=>$('fileInput').click();
$('fileInput').onchange=async e=>{const errors=[];let last;for(const file of e.target.files){try{last=accept(await file.arrayBuffer(),file.name);}catch(error){errors.push(`${file.name}: ${error.message}`);}}if(last)populate(last.meter);showError(errors.join(' · '));e.target.value='';};
$('meter').onchange=populatePeriods;$('gridMeter').onchange=populatePeriods;$('solarMeter').onchange=populatePeriods;$('period').onchange=resetDates;$('resetFilters').onclick=resetDates;
for(const id of ['from','to'])$(id).onchange=()=>{page=0;render();};
$('rawDay').onchange=renderRaw;$('prevPage').onclick=()=>{page--;renderDaily();};$('nextPage').onclick=()=>{page++;renderDaily();};
document.querySelectorAll('[data-chart]').forEach(button=>button.onclick=()=>{chartMode=button.dataset.chart;document.querySelectorAll('[data-chart]').forEach(b=>b.classList.toggle('active',b===button));drawMainChart();});
$('aboutButton').onclick=()=>$('aboutDialog').showModal();$('closeDialog').onclick=()=>$('aboutDialog').close();
$('aboutDialog').onclick=e=>{if(e.target===$('aboutDialog'))$('aboutDialog').close();};
initializeBalanceView();
window.addEventListener('hashchange',()=>changeView(location.hash.slice(1)));changeView(location.hash.slice(1));
await Promise.all(names.map(async name=>{try{const response=await fetch(`./samples/${name}`);if(!response.ok)throw Error(String(response.status));accept(await response.arrayBuffer(),name);}catch(error){console.error('Sample unavailable',name,error);}}));
if(datasets.size){populate('SIM_OFFICE');}else{showError('โหลดข้อมูลตัวอย่างไม่สำเร็จ คุณยังเลือกนำเข้าไฟล์ .tou ได้ด้วยปุ่มด้านบน');$('sampleDescription').textContent='เลือกไฟล์ .tou เพื่อเริ่มดูข้อมูล';}

import {analyzeBalance} from './energy-balance.mjs';

const $=id=>document.getElementById(id);
const n=(v,d=2)=>v===null||v===undefined||!Number.isFinite(v)?'—':v.toLocaleString('en-US',{maximumFractionDigits:d});
const shortDate=date=>new Date(date+'T00:00:00Z').toLocaleDateString('th-TH',{day:'numeric',month:'short',timeZone:'UTC'});
const fullDate=date=>new Date(date+'T00:00:00Z').toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric',calendar:'gregory',timeZone:'UTC'});
const series=[{key:'gridKw',color:'#7196c6',name:'MEA'},{key:'solarKw',color:'#e0a051',name:'Solar'},{key:'loadKw',color:'#008c82',name:'โหลดรวม'}];
let current=null,mode='power',page=0,previousKey='';

export function initializeBalanceView(){
 $('balanceDay').onchange=drawChart;
 document.querySelectorAll('[data-balance-chart]').forEach(button=>button.onclick=()=>{
  mode=button.dataset.balanceChart;
  document.querySelectorAll('[data-balance-chart]').forEach(b=>b.classList.toggle('active',b===button));drawChart();
 });
 $('balancePrev').onclick=()=>{page--;drawTable();};$('balanceNext').onclick=()=>{page++;drawTable();};
}

export function renderBalanceDashboard(grid,solar,options){
 const data=analyzeBalance(grid,solar,options);
 const key=[grid.name,solar.name,options.from,options.to].join('|');
 if(key!==previousKey)page=0;previousKey=key;current=data;
 const t=data.totals;
 for(const [id,value]of [['balanceLoad',t.loadKwh],['balanceGrid',t.gridKwh],['balanceSolar',t.solarKwh],['balanceShare',t.solarSharePct]])$(id).textContent=n(value,id==='balanceShare'?1:2);
 $('solarShareBar').style.width=`${Math.max(0,Math.min(100,t.solarSharePct??0))}%`;
 for(const [id,value]of [['flowGrid',t.gridKwh],['flowSolar',t.solarKwh],['flowLoad',t.loadKwh]])$(id).textContent=`${n(value)} kWh`;
 for(const [id,value]of [['balanceGridPeak',t.gridPeakKw],['balanceSolarPeak',t.solarPeakKw],['balanceLoadPeak',t.loadPeakKw]])$(id).textContent=`${n(value,3)} kW`;
 $('balanceLoadPeak').title=t.peakAt||'';
 $('balanceCoverage').textContent=`${n(data.coveragePct,1)}%`;
 $('coverageBar').style.width=`${data.coveragePct??0}%`;
 $('balanceCoverageNote').textContent=`${n(t.validIntervals,0)} / ${n(t.expectedIntervals,0)} ช่วง · ${t.incompleteDays?t.incompleteDays+' วันข้อมูลไม่ครบ':'ข้อมูลครบทั้งสองมิเตอร์'}`;
 spark('loadSpark',data.days.map(d=>d.loadKwh),'#008c82');spark('gridSpark',data.days.map(d=>d.gridKwh),'#7196c6');spark('solarSpark',data.days.map(d=>d.solarKwh),'#e0a051');
 const oldDay=$('balanceDay').value;
 $('balanceDay').replaceChildren(...data.days.map(d=>new Option(fullDate(d.date),d.date)));
 if(data.days.some(d=>d.date===oldDay))$('balanceDay').value=oldDay;
 drawChart();drawDonut();drawTable();return data;
}

export function clearBalanceDashboard(message='เลือกไฟล์ MEA และ Solar ที่เป็นเดือนเดียวกัน'){
 current=null;
 for(const id of ['balanceLoad','balanceGrid','balanceSolar','balanceShare','balanceGridPeak','balanceSolarPeak','balanceLoadPeak','balanceCoverage'])$(id).textContent='—';
 for(const id of ['loadSpark','gridSpark','solarSpark','sourceDonut','sourceSplit','balanceTotal'])$(id).replaceChildren();
 for(const id of ['flowGrid','flowSolar','flowLoad'])$(id).textContent='—';
 $('solarShareBar').style.width='0%';$('coverageBar').style.width='0%';
 $('balanceDay').replaceChildren();$('balanceChart').textContent=message;
 $('balanceChart').onpointermove=null;$('balanceChart').onpointerleave=null;
 $('balanceTooltip').classList.add('hidden');$('balanceChartDates').textContent='—';
 $('balanceLoadPeak').title='';$('dataRange').textContent='ยังไม่มีคู่ข้อมูล';
 $('balanceTable').innerHTML='<tr><td colspan="7" class="empty-state">ไม่มีข้อมูลที่จับคู่ได้</td></tr>';
 $('balanceCoverageNote').textContent=message;$('balanceTableCount').textContent='ไม่มีข้อมูล';$('balancePageLabel').textContent='0 / 0';
 $('balancePrev').disabled=true;$('balanceNext').disabled=true;
}

function spark(id,values,color){
 const max=Math.max(1,...values.filter(v=>v!==null));let path='',joined=false;
 values.forEach((v,i)=>{if(v===null){joined=false;return;}path+=`${joined?'L':'M'}${(i/Math.max(1,values.length-1)*240).toFixed(2)},${(32-v/max*28).toFixed(2)} `;joined=true;});
 $(id).innerHTML=`<svg viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/></svg>`;
}

function drawDonut(){
 if(!current)return;const t=current.totals,circ=2*Math.PI*68,total=t.loadKwh;
 let offset=0;const arcs=[t.gridKwh,t.solarKwh].map((v,i)=>{const length=total>0?(v??0)/total*circ:0;const arc=`<circle cx="96" cy="96" r="68" fill="none" stroke="${i?'#e0a051':'#7196c6'}" stroke-width="20" stroke-dasharray="${Math.max(0,length-2)} ${circ}" stroke-dashoffset="${-offset}" transform="rotate(-90 96 96)"/>`;offset+=length;return arc;}).join('');
 $('sourceDonut').innerHTML=`<svg viewBox="0 0 192 192" role="img" aria-label="สัดส่วนพลังงาน MEA และ Solar"><circle cx="96" cy="96" r="68" fill="none" stroke="#edf2f5" stroke-width="20"/>${arcs}</svg><div class="donut-center"><span>พลังงาน Solar</span><strong>${n(t.solarSharePct,1)}<small class="donut-percent">%</small></strong><small>ของพลังงานที่ใช้รวม</small></div>`;
 $('sourceSplit').innerHTML=[{name:'MEA · ซื้อเข้า',value:t.gridKwh,color:'#7196c6'},{name:'Solar · ผลิตใช้เอง',value:t.solarKwh,color:'#e0a051'}].map(s=>`<div class="split-row"><i class="dot" style="background:${s.color}"></i><span class="split-name">${s.name}</span><strong>${n(s.value)}</strong><span class="split-percent">kWh</span></div>`).join('');
}

function drawChart(){
 if(!current)return;
 const daily=mode==='daily',day=$('balanceDay').value;
 $('balanceDayField').classList.toggle('hidden',daily);
 $('balanceChartTitle').textContent=daily?'พลังงาน MEA + Solar รายวัน':'MEA เทียบกับ Solar และโหลดอาคาร';
 $('balanceChartSubtitle').textContent=daily?'พลังงานในช่วงข้อมูลตรงกัน · kWh':'กำลังไฟฟ้าราย 15 นาที · kW';
 const points=daily?current.days:current.rows.filter(r=>r.date===day);
 const max=Math.max(1,...points.map(p=>daily?p.loadKwh??0:Math.max(p.gridKw??0,p.solarKw??0,p.loadKw??0)))*1.14;
 const W=760,H=270,L=48,R=18,T=16,B=36,width=W-L-R,height=H-T-B;
 let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟเปรียบเทียบ MEA Solar และโหลดรวม"><defs><linearGradient id="solarArea" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e0a051" stop-opacity=".24"/><stop offset="1" stop-color="#e0a051" stop-opacity=".02"/></linearGradient></defs>`;
 for(let i=0;i<=4;i++){const y=T+height*i/4;svg+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" class="grid-line"/><text x="${L-10}" y="${y+4}" text-anchor="end" class="axis-label">${n(max*(1-i/4),0)}</text>`;}
 if(daily){
  const step=width/Math.max(1,points.length);let totalLine='',connected=false;
  points.forEach((p,i)=>{
   if(p.loadKwh===null){connected=false;return;}
   const x=L+i*step+step*.2,bw=step*.6,gridH=p.gridKwh/max*height,solarH=p.solarKwh/max*height,y=T+height-(gridH+solarH);
   svg+=`<rect x="${x}" y="${T+height-gridH}" width="${bw}" height="${gridH}" rx="2" fill="#7196c6"/><rect x="${x}" y="${y}" width="${bw}" height="${solarH}" rx="2" fill="#e0a051"/>`;
   totalLine+=`${connected?'L':'M'}${L+(i+.5)*step},${y} `;connected=true;
  });svg+=`<path d="${totalLine}" fill="none" stroke="#008c82" stroke-width="1.8"/>`;
  points.forEach((p,i)=>{if(i%Math.max(1,Math.ceil(points.length/7))===0||i===points.length-1)svg+=`<text x="${L+(i+.5)*step}" y="${H-10}" text-anchor="middle" class="axis-label">${shortDate(p.date)}</text>`;});
 }else{
  const start=Date.parse(day+'T00:00:00Z');
  for(const s of series){
   let groups=[],group=[];const flush=()=>{if(group.length){groups.push(group);group=[];}};
   points.forEach(p=>{if(p[s.key]===null){flush();return;}group.push([L+(p.ts-start)/86400000*width,T+height-p[s.key]/max*height]);});flush();
   for(const g of groups){const path=g.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');if(s.key==='solarKw')svg+=`<path d="${path} L${g.at(-1)[0]},${T+height} L${g[0][0]},${T+height} Z" fill="url(#solarArea)"/>`;svg+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.key==='loadKw'?2.1:1.8}" stroke-linejoin="round"/>`;}
  }
  for(let hour=0;hour<=24;hour+=4)svg+=`<text x="${L+hour/24*width}" y="${H-10}" text-anchor="middle" class="axis-label">${String(hour).padStart(2,'0')}:00</text>`;
 }
 $('balanceChart').innerHTML=svg+'</svg>';
 $('balanceChartDates').textContent=daily?(points.length?`${fullDate(points[0].date)} — ${fullDate(points.at(-1).date)}`:'ไม่มีข้อมูล'):day?fullDate(day):'ไม่มีข้อมูล';
 $('balanceChart').onpointermove=e=>{
  const box=$('balanceChart').querySelector('svg').getBoundingClientRect(),fraction=Math.max(0,Math.min(1,((e.clientX-box.left)/box.width*W-L)/width));
  const p=points[Math.min(points.length-1,Math.round(fraction*(points.length-1)))];if(!p)return;
  const text=daily?`${shortDate(p.date)} · MEA ${n(p.gridKwh)} / Solar ${n(p.solarKwh)} kWh`:`${p.time} · MEA ${n(p.gridKw,2)} / Solar ${n(p.solarKw,2)} / รวม ${n(p.loadKw,2)} kW`;
  const tip=$('balanceTooltip');tip.textContent=text;tip.style.left='18px';tip.style.top='90px';tip.classList.remove('hidden');
 };
 $('balanceChart').onpointerleave=()=>$('balanceTooltip').classList.add('hidden');
}

function drawTable(){
 if(!current)return;const days=current.days,size=7,pages=Math.max(1,Math.ceil(days.length/size));page=Math.max(0,Math.min(page,pages-1));
 const status={complete:'ครบถ้วน',incomplete:'ข้อมูลบางช่วง','no-data':'ไม่มีข้อมูลร่วม'};
 $('balanceTable').innerHTML=days.slice(page*size,(page+1)*size).map(d=>`<tr><td><strong>${fullDate(d.date)}</strong></td><td class="numeric">${n(d.gridKwh)}</td><td class="numeric solar-number">${n(d.solarKwh)}</td><td class="numeric total-cell">${n(d.loadKwh)}</td><td class="numeric">${n(d.solarSharePct,1)}${d.solarSharePct===null?'':'%'}</td><td class="numeric">${d.validIntervals} / ${d.expectedIntervals}</td><td><span class="status-badge ${d.status==='complete'?'ok':d.status==='no-data'?'muted':'warning'}">${status[d.status]}</span></td></tr>`).join('');
 if(!days.length)$('balanceTable').innerHTML='<tr><td colspan="7" class="empty-state">ไม่มีข้อมูลในช่วงที่เลือก</td></tr>';
 const t=current.totals;
 $('balanceTotal').innerHTML=`<tr><td>รวมช่วงที่จับคู่ได้</td><td class="numeric">${n(t.gridKwh)}</td><td class="numeric">${n(t.solarKwh)}</td><td class="numeric">${n(t.loadKwh)}</td><td class="numeric">${n(t.solarSharePct,1)}${t.solarSharePct===null?'':'%'}</td><td class="numeric">${t.validIntervals} / ${t.expectedIntervals}</td><td>${t.incompleteDays?t.incompleteDays+' วันไม่ครบ':'ครบถ้วน'}</td></tr>`;
 $('balanceTableCount').textContent=`แสดง ${days.length?page*size+1:0}–${Math.min(days.length,(page+1)*size)} จาก ${days.length} วัน`;
 $('balancePageLabel').textContent=`${page+1} / ${pages}`;$('balancePrev').disabled=page===0;$('balanceNext').disabled=page+1>=pages;
}

export function balanceCsvRows(){
 if(!current)return [];
 const t=current.totals;
 return [['MEA meter','Solar meter','Date','MEA kWh','Solar kWh','Load kWh','Solar share %','MEA peak kW','Solar peak kW','Coincident load peak kW','Paired intervals','Expected intervals','Status'],...current.days.map(d=>[current.gridMeter,current.solarMeter,d.date,d.gridKwh,d.solarKwh,d.loadKwh,d.solarSharePct,d.gridPeakKw,d.solarPeakKw,d.loadPeakKw,d.validIntervals,d.expectedIntervals,d.status]),[current.gridMeter,current.solarMeter,'TOTAL',t.gridKwh,t.solarKwh,t.loadKwh,t.solarSharePct,t.gridPeakKw,t.solarPeakKw,t.loadPeakKw,t.validIntervals,t.expectedIntervals,`${t.incompleteDays} incomplete days; solar self-consumed, no export/battery`]];
}

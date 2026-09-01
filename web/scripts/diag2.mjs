import postgres from 'postgres';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const TZ = process.env.TIMEKEEPER_TZ || 'America/New_York';
const parse = s => DateTime.fromFormat(s, "yyyy-MM-dd'T'HH:mm:ss", {zone:TZ});
const wd = dt => dt.weekday-1;
const combine=(d,t)=>{const[h,m]=t.split(':').map(Number);return d.set({hour:h,minute:m,second:0,millisecond:0});};
const shiftEnd=(d,s,e)=>{const en=combine(d,e);return e<=s?en.plus({days:1}):en;};
const G=15,LATE=5,EARLY=3,OT=5;
function contain(shifts,t){const date=t.startOf('day');for(const s of shifts){const st=combine(date,s.start),en=shiftEnd(date,s.start,s.end);if(t.toMillis()>=st.minus({minutes:G}).toMillis()&&t.toMillis()<en.toMillis())return[st,en];}return null;}
const sql = postgres(process.env.DATABASE_URL,{prepare:false});
const emps = await sql`select id,name from employees order by name`;
const entries = await sql`select employee_id, clock_in, clock_out, actual_in, actual_out from time_entries`;
const scheds = await sql`select employee_id, weekday, start_time start, end_time end from schedules`;
const byWd = new Map();
for (const s of scheds){const k=`${s.employee_id}:${s.weekday}`; if(!byWd.has(k))byWd.set(k,[]); byWd.get(k).push({start:s.start,end:s.end});}
const now = DateTime.now().setZone(TZ); const win = now.minus({days:90});
const cinByDate = new Map();
for(const en of entries){const cin=parse(en.clock_in);const k=`${en.employee_id}:${cin.toFormat('yyyy-MM-dd')}`;if(!cinByDate.has(k))cinByDate.set(k,[]);cinByDate.get(k).push(cin);}
for (const e of emps){
  let shifts=0,late=0,early=0,ot=0,forgot=0,missed=0;
  for(const en of entries){ if(en.employee_id!==e.id)continue; const cin=parse(en.clock_in); if(cin.toMillis()<win.toMillis())continue; shifts++;
    if(en.actual_in){const ai=parse(en.actual_in);const w=contain(byWd.get(`${e.id}:${wd(ai)}`)??[],ai);
      if(w){if(ai.toMillis()>w[0].plus({minutes:LATE}).toMillis())late++;if(ai.toMillis()<w[0].minus({minutes:EARLY}).toMillis())early++;if(en.actual_out&&parse(en.actual_out).toMillis()>w[1].plus({minutes:OT}).toMillis())ot++;}
      if(!en.actual_out)forgot++;}
  }
  let d=win.startOf('day'); const today=now.startOf('day');
  while(d.toMillis()<today.toMillis()){const shs=byWd.get(`${e.id}:${wd(d)}`)??[];if(shs.length&&shs.every(s=>shiftEnd(d,s.start,s.end).toMillis()<=now.toMillis())){const cs=cinByDate.get(`${e.id}:${d.toFormat('yyyy-MM-dd')}`)??[];if(!cs.length)missed++;}d=d.plus({days:1});}
  console.log(`${e.name}: shifts=${shifts} late=${late} early=${early} overtime=${ot} forgotOut=${forgot} missed=${missed}`);
}
await sql.end();

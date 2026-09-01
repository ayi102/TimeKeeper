import postgres from 'postgres';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const TZ=process.env.TIMEKEEPER_TZ||'America/New_York';
const parse=s=>DateTime.fromFormat(s,"yyyy-MM-dd'T'HH:mm:ss",{zone:TZ});
const wd=dt=>dt.weekday-1;
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
const emps=await sql`select id,name from employees order by name`;
const scheds=await sql`select employee_id,weekday from schedules`;
const entries=await sql`select employee_id,clock_in from time_entries`;
const now=DateTime.now().setZone(TZ), win=now.minus({days:90}).startOf('day'), today=now.startOf('day');
const schedWd=new Map(); for(const s of scheds){if(!schedWd.has(s.employee_id))schedWd.set(s.employee_id,new Set());schedWd.get(s.employee_id).add(s.weekday);}
const worked=new Map(), first=new Map();
for(const e of entries){const c=parse(e.clock_in);const day=c.toFormat('yyyy-MM-dd');if(!worked.has(e.employee_id))worked.set(e.employee_id,new Set());worked.get(e.employee_id).add(day);if(!first.has(e.employee_id)||c.toMillis()<first.get(e.employee_id).toMillis())first.set(e.employee_id,c);}
for(const e of emps){
  const wds=schedWd.get(e.id)||new Set(); const wk=worked.get(e.id)||new Set();
  const fEntry=first.get(e.id); const floor=DateTime.max(win, fEntry.startOf('day'));
  let missedFull=0, missedFromFirst=0;
  let d=win; while(d.toMillis()<today.toMillis()){ if(wds.has(wd(d))){ const has=wk.has(d.toFormat('yyyy-MM-dd')); if(!has)missedFull++; if(!has && d.toMillis()>=floor.toMillis())missedFromFirst++; } d=d.plus({days:1}); }
  console.log(`${e.name}: first clock-in ${fEntry.toFormat('yyyy-MM-dd')} | missed(90d)=${missedFull} | missed(since first tracked)=${missedFromFirst}`);
}
await sql.end();

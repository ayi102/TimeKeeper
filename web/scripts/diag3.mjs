import postgres from 'postgres';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const TZ=process.env.TIMEKEEPER_TZ||'America/New_York';
const parse=s=>DateTime.fromFormat(s,"yyyy-MM-dd'T'HH:mm:ss",{zone:TZ});
const wd=dt=>dt.weekday-1;
const DAY=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
const emps=await sql`select id,name from employees order by name`;
const scheds=await sql`select employee_id,weekday from schedules`;
const entries=await sql`select employee_id,clock_in from time_entries`;
const now=DateTime.now().setZone(TZ), win=now.minus({days:90}).startOf('day'), today=now.startOf('day');
const schedWd=new Map(); for(const s of scheds){if(!schedWd.has(s.employee_id))schedWd.set(s.employee_id,new Set());schedWd.get(s.employee_id).add(s.weekday);}
const workedDays=new Map(); for(const e of entries){const c=parse(e.clock_in);if(c.toMillis()>=win.toMillis()){const k=`${e.employee_id}:${c.toFormat('yyyy-MM-dd')}`;if(!workedDays.has(e.employee_id))workedDays.set(e.employee_id,new Set());workedDays.get(e.employee_id).add(c.toFormat('yyyy-MM-dd'));}}
for(const e of emps){
  const wds=schedWd.get(e.id)||new Set();
  let schedDays=0; let d=win; while(d.toMillis()<today.toMillis()){if(wds.has(wd(d)))schedDays++;d=d.plus({days:1});}
  const worked=(workedDays.get(e.id)||new Set()).size;
  console.log(`${e.name}: scheduled ${[...wds].sort().map(w=>DAY[w]).join(',')} (${wds.size} days/wk) -> ${schedDays} scheduled days in 90d, clocked in on ${worked} days, ~${schedDays-worked} missed`);
}
await sql.end();

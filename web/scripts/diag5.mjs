import postgres from 'postgres';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
const env=readFileSync(new URL('../.env.local',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const TZ=process.env.TIMEKEEPER_TZ||'America/New_York';
const parse=s=>DateTime.fromFormat(s,"yyyy-MM-dd'T'HH:mm:ss",{zone:TZ}); const wd=d=>d.weekday-1;
const combine=(d,t)=>{const[h,m]=t.split(':').map(Number);return d.set({hour:h,minute:m,second:0,millisecond:0});};
const shiftEnd=(d,s,e)=>{const en=combine(d,e);return e<=s?en.plus({days:1}):en;};
const G=15; function contain(sh,t){const dt=t.startOf('day');for(const s of sh){const st=combine(dt,s.start),en=shiftEnd(dt,s.start,s.end);if(t.toMillis()>=st.minus({minutes:G}).toMillis()&&t.toMillis()<en.toMillis())return[st,en];}return null;}
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
const emps=await sql`select id,name from employees order by name`;
const entries=await sql`select employee_id,clock_in,actual_in,actual_out from time_entries`;
const scheds=await sql`select employee_id,weekday,start_time start,end_time end from schedules`;
const byWd=new Map();for(const s of scheds){const k=`${s.employee_id}:${s.weekday}`;if(!byWd.has(k))byWd.set(k,[]);byWd.get(k).push({start:s.start,end:s.end});}
const now=DateTime.now().setZone(TZ),win=now.minus({days:90});
for(const e of emps){let ot=0,un=0;for(const en of entries){if(en.employee_id!==e.id)continue;const cin=parse(en.clock_in);if(cin.toMillis()<win.toMillis())continue;if(!en.actual_in||!en.actual_out)continue;const ai=parse(en.actual_in),ao=parse(en.actual_out);const w=contain(byWd.get(`${e.id}:${wd(ai)}`)??[],ai);if(!w)continue;ot+=Math.max(0,ao.diff(w[1],'seconds').seconds);un+=Math.max(0,ai.diff(w[0],'seconds').seconds)+Math.max(0,w[1].diff(ao,'seconds').seconds);}
console.log(`${e.name}: overtime=${(ot/3600).toFixed(1)}h undertime=${(un/3600).toFixed(1)}h`);}
await sql.end();

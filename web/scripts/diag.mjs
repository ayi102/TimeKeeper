import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql = postgres(process.env.DATABASE_URL,{prepare:false});
console.log('=== null actual_in/out counts ===');
for (const r of await sql`select e.name, count(*)::int n,
   sum(case when t.actual_out is null then 1 else 0 end)::int null_out,
   sum(case when t.actual_in is null then 1 else 0 end)::int null_in
   from time_entries t join employees e on e.id=t.employee_id group by e.name order by e.name`)
  console.log(`  ${r.name}: ${r.n} entries, null_out=${r.null_out}, null_in=${r.null_in}`);
console.log('=== schedules ===');
const DAY=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
for (const r of await sql`select e.name, s.weekday, s.start_time, s.end_time from schedules s join employees e on e.id=s.employee_id order by e.name, s.weekday, s.start_time`)
  console.log(`  ${r.name} ${DAY[r.weekday]} ${r.start_time}-${r.end_time}`);
console.log('=== 12 most recent entries ===');
for (const r of await sql`select e.name, t.clock_in, t.actual_in, t.clock_out, t.actual_out from time_entries t join employees e on e.id=t.employee_id order by t.clock_in desc limit 12`)
  console.log(`  ${r.name} in:${r.clock_in} (tap ${r.actual_in}) out:${r.clock_out} (tap ${r.actual_out})`);
await sql.end();

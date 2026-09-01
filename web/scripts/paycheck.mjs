import postgres from 'postgres';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
const env=readFileSync(new URL('../.env.local',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const TZ=process.env.TIMEKEEPER_TZ||'America/New_York';
const parse=s=>DateTime.fromFormat(s,"yyyy-MM-dd'T'HH:mm:ss",{zone:TZ});
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
// Any entry longer than 13h = suspiciously long (possible cap/auto-close to the bogus end)
const rows=await sql`select e.name, t.clock_in, t.clock_out, t.actual_out from time_entries t join employees e on e.id=t.employee_id where t.clock_out is not null`;
let flagged=0;
for(const r of rows){const h=parse(r.clock_out).diff(parse(r.clock_in),'hours').hours; if(h>13){flagged++;console.log(`${r.name}: ${r.clock_in} -> ${r.clock_out} = ${h.toFixed(1)}h  (tap-out: ${r.actual_out??'NONE — auto-closed'})`);}}
if(!flagged) console.log('No entries longer than 13h — no overpayment from the bogus shift.');
await sql.end();

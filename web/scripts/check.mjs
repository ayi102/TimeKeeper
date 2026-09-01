import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql = postgres(process.env.DATABASE_URL,{prepare:false});
const emps = await sql`select id,name,hourly_rate,active from employees order by id`;
console.log('Workers:'); for(const e of emps) console.log(`  #${e.id} ${e.name} $${e.hourly_rate}/hr ${e.active?'active':'inactive'}`);
const [open] = await sql`select count(*)::int c from time_entries where clock_out is null`;
console.log('Open (still clocked-in) entries:', open.c);
const meds = await sql`select name, active from medications order by id`;
console.log('Meds:', meds.map(m=>m.name+(m.active?'':' (off)')).join(', '));
await sql.end();

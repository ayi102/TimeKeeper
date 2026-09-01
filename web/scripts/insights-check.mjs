import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql = postgres(process.env.DATABASE_URL,{prepare:false});
const [range] = await sql`select min(clock_in) lo, max(clock_in) hi, count(*)::int c from time_entries`;
console.log('entries:', range.c, 'from', range.lo, 'to', range.hi);
const byMonth = await sql`select substr(clock_in,1,7) ym, count(*)::int c from time_entries group by 1 order by 1 desc limit 8`;
console.log('by month:'); for(const r of byMonth) console.log('  ', r.ym, r.c);
await sql.end();

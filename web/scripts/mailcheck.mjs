import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env=readFileSync(new URL('../.env.local',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
const rows=await sql`select key from settings where key like 'mail_%'`;
console.log('mail settings in DB:', rows.length? rows.map(r=>r.key).join(', ') : '(none set)');
await sql.end();

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql = postgres(process.env.DATABASE_URL,{prepare:false});
const cols = (await sql`select column_name from information_schema.columns where table_name='medications'`).map(c=>c.column_name);
if (cols.includes('dose') && !cols.includes('notes')) { await sql`alter table medications rename column dose to notes`; console.log('Renamed dose -> notes'); }
else console.log('No change needed. Columns:', cols.join(','));
await sql.end();

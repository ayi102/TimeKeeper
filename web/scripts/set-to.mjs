import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env=readFileSync(new URL('../.env.local',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
await sql`insert into settings (key,value) values ('mail_to','zainabjamal01@gmail.com') on conflict (key) do update set value=excluded.value`;
console.log('recipient set to zainabjamal01@gmail.com');
await sql.end();

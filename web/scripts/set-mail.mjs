import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const env=readFileSync(new URL('../.env.local',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const sql=postgres(process.env.DATABASE_URL,{prepare:false});
const set=async(k,v)=>sql`insert into settings (key,value) values (${k},${v}) on conflict (key) do update set value=excluded.value`;
await set('mail_host','smtp.gmail.com');
await set('mail_port','587');
await set('mail_user','aismail102@gmail.com');
await set('mail_password','njfuibypywrgogzk');
await set('mail_to','aismail102@gmail.com');
console.log('mail settings saved (from/to aismail102@gmail.com)');
await sql.end();

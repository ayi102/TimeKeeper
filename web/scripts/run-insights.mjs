import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env.local', import.meta.url),'utf8');
for (const l of env.split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2];}
const { computeInsights } = await import('../lib/insights.ts');
const r = await computeInsights();
for (const w of r.workers) console.log(w.name, '| thisMo', w.thisMonth, '| behavior', JSON.stringify(w.behavior));
process.exit(0);

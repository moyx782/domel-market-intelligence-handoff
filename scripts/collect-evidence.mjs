import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const dir=join(root,'evidence','runs',stamp);mkdirSync(dir,{recursive:true});
const steps=[['typecheck',['node_modules/typescript/bin/tsc','-b']],['build',['node_modules/vite/bin/vite.js','build']],['tests',['--test',...readdirSync(join(root,'tests')).filter(x=>x.endsWith('.test.mjs')).map(x=>'tests/'+x)]]];
const results=[];
for(const [name,args] of steps){
 const start=new Date().toISOString();const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000});
 const log=`Started: ${start}\nCommand: node ${args.join(' ')}\n\n${r.stdout||''}${r.stderr||''}\nExit code: ${r.status}\n${r.error?.message||''}`;
 writeFileSync(join(dir,name+'.log'),log);results.push({name,command:['node',...args],exitCode:r.status,startedAt:start});console.log(`${name}: ${r.status===0?'PASS':'FAIL'}`);
}
const hashes={};
function hashTree(folder){for(const name of readdirSync(join(root,folder))){const file=join(folder,name);if(statSync(join(root,file)).isDirectory())hashTree(file);else hashes[file.replaceAll('\\','/')]=createHash('sha256').update(readFileSync(join(root,file))).digest('hex');}}
for(const folder of ['src','supabase','tests'])hashTree(folder);
hashes['package-lock.json']=createHash('sha256').update(readFileSync(join(root,'package-lock.json'))).digest('hex');
const summary={capturedAt:new Date().toISOString(),runtime:process.version,platform:process.platform,results,sourceSha256:hashes,verificationLimits:['Local automated tests and embedded PostgreSQL only.','No hosted Supabase Auth, deployed RLS, real retrieval, real AI, or user study was executed.','Demo results must not be represented as real market research.']};
writeFileSync(join(dir,'summary.json'),JSON.stringify(summary,null,2));console.log('Evidence: '+relative(root,dir));
if(results.some(x=>x.exitCode!==0))process.exitCode=1;

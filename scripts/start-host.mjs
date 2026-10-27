import {spawn} from 'node:child_process';
import {mkdirSync,openSync,writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import net from 'node:net';
const root=fileURLToPath(new URL('../',import.meta.url));const runtime=resolve(root,'.runtime');mkdirSync(runtime,{recursive:true});
const listening=port=>new Promise(r=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();r(true);});socket.once('error',()=>r(false));socket.once('timeout',()=>{socket.destroy();r(false);});});
function launch(name,args){const child=spawn(process.execPath,args,{cwd:root,detached:true,windowsHide:true,stdio:['ignore',openSync(resolve(runtime,name+'.out.log'),'a'),openSync(resolve(runtime,name+'.err.log'),'a')]});child.unref();writeFileSync(resolve(runtime,name+'.pid'),String(child.pid));console.log(name+' started.');}
if(!await listening(5174))launch('frontend',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort']);else console.log('Frontend port 5174 already running.');
if(!await listening(8787))launch('api',['--env-file-if-exists=.env','--env-file-if-exists=.env.host','server/api.mjs']);else console.log('API port 8787 already running.');
let workerAlive=false;try{process.kill(Number(readFileSync(resolve(runtime,'worker.pid'),'utf8')),0);workerAlive=true;}catch{}
if(!workerAlive)launch('worker',['--env-file-if-exists=.env.host','server/worker.mjs']);else console.log('Tracked worker already running.');
console.log('Open http://127.0.0.1:5174/ . Local services stop when the computer shuts down.');

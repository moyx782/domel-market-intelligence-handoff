// Local development launcher. Keeps services detached and records startup logs.
import {spawn} from 'node:child_process';
import {mkdirSync,openSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import net from 'node:net';
const root=fileURLToPath(new URL('../',import.meta.url));
const runtime=join(root,'.runtime');mkdirSync(runtime,{recursive:true});
const env={...process.env,LOCAL_API_PORT:'8795',LOCAL_API_URL:'http://127.0.0.1:8795',APP_ORIGINS:'http://127.0.0.1:5195,http://localhost:5195',VITE_APP_MODE:'local',VITE_BACKEND_URL:'http://127.0.0.1:8795'};
const listening=port=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(800);const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.once('timeout',()=>done(false));});
async function launch(name,port,args){
 if(await listening(port)){console.log(name+' already listening on '+port);return;}
 const child=spawn(process.execPath,args,{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',openSync(join(runtime,name+'.out.log'),'a'),openSync(join(runtime,name+'.err.log'),'a')]});
 child.on('error',()=>console.error(name+' could not start. Check the Node installation.'));
 child.unref();if(child.pid)writeFileSync(join(runtime,name+'.pid'),String(child.pid));
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){if(await listening(port)){console.log(name+' ready on '+port);return;}await new Promise(r=>setTimeout(r,250));}
 throw Error(name+' did not become ready. See .runtime/'+name+'.err.log');
}
try{
 await launch('api',8795,['--env-file-if-exists=.env.host','server/local-api.mjs']);
 await launch('frontend',5195,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5195','--strictPort']);
 const response=await fetch('http://127.0.0.1:8795/api/v1/exhibition-studies',{headers:{Origin:'http://127.0.0.1:5195'},signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('Exhibition API check failed (HTTP '+response.status+'). Verify port 8795 belongs to this project.');
 console.log('Open http://127.0.0.1:5195/ . No login is required for this single-user local demo.');
}catch(error){console.error(error.message);process.exitCode=1;}

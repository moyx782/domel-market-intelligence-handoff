import test from 'node:test';
import assert from 'node:assert/strict';
import {apiServer} from '../server/api.mjs';

const PROJECT='00000000-0000-4000-8000-000000000032';
const client={auth:{getUser:async token=>token==='valid'?{data:{user:{id:'user-1'}}}:{data:{user:null},error:true}}};

function start(options){
 const server=apiServer({clientForToken:()=>client,...options});
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}

const post=(server,body,path='/api/v1/research-tasks/'+PROJECT+'/assistant')=>fetch(
 'http://127.0.0.1:'+server.address().port+path,
 {method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify(body)},
);

test('assistant route streams committed events as SSE',async()=>{
 const calls=[];
 const assistant=async input=>{
  calls.push({userId:input.userId,projectId:input.projectId,message:input.message});
  input.onEvent({type:'tool_start',tool:'get_project'});
  input.onEvent({type:'delta',text:'Partial '});
  input.onEvent({type:'delta',text:'answer'});
  input.onEvent({type:'done',text:'Partial answer'});
 };
 const server=await start({assistant,capabilities:{ai:true}});
 try{
  const response=await post(server,{message:' Summarize this project. '});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const events=(await response.text()).trim().split('\n\n').map(chunk=>JSON.parse(chunk.replace(/^data: /,'')));
  assert.deepEqual(events.map(event=>event.type),['tool_start','delta','delta','done']);
  assert.deepEqual(calls,[{userId:'user-1',projectId:PROJECT,message:'Summarize this project.'}]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('assistant route rejects missing configuration and empty messages',async()=>{
 const configured=await start({assistant:async()=>{}});
 const unconfigured=await start({});
 try{
  assert.equal((await post(configured,{message:'   '})).status,400);
  assert.equal((await post(unconfigured,{message:'hello'})).status,503);
  const capabilities=await fetch('http://127.0.0.1:'+configured.address().port+'/api/v1/capabilities',{headers:{Authorization:'Bearer valid'}});
  assert.equal((await capabilities.json()).assistant,true);
 }finally{
  await new Promise(resolve=>configured.close(resolve));
  await new Promise(resolve=>unconfigured.close(resolve));
 }
});

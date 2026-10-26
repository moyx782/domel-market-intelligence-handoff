import test from 'node:test';
import assert from 'node:assert/strict';
import {apiServer} from '../server/api.mjs';
test('host API authenticates tokens, enforces CORS, overrides owner and forwards review revision',async()=>{
 let inserted,rpc;
 const client={auth:{getUser:async token=>token==='valid'?{data:{user:{id:'actual-owner'}}}:{data:{user:null},error:true}},from:()=>({insert:row=>{inserted=row;return{select:()=>({single:async()=>({data:row})})};}}),rpc:async(name,body)=>{rpc={name,body};return{data:{id:'result'}};}};
 const server=apiServer({clientForToken:()=>client,capabilities:{ai:true}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 const request=(path,body,headers={},method='POST')=>fetch(url+path,{method,headers:{Authorization:'Bearer valid','Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
 assert.equal((await fetch(url+'/api/v1/workspace')).status,401);
 assert.equal((await request('/api/v1/workspace',null,{Authorization:'Bearer invalid'},'GET')).status,401);
 assert.equal((await request('/api/v1/workspace',null,{Origin:'https://evil.test'},'GET')).status,403);
 const scope={title:'Test',question:'Question',segment:'Motor',market:'EU',quarter:'2026-Q3',competitors:['A'],focus:['Custom'],source_urls:[],owner_id:'attacker'};
 assert.equal((await request('/api/v1/research-tasks',scope)).status,201);assert.equal(inserted.owner_id,'actual-owner');
 const id='00000000-0000-4000-8000-000000000003';
 assert.equal((await request('/api/v1/research-tasks/'+id+'/run',{mode:'research',environment:'attacker'})).status,202);assert.equal(rpc.body.p_environment,'development');
 await request('/api/v1/insights/'+id+'/review',{text:'Reviewed',decision:'accepted',revision:4},{},'PATCH');assert.equal(rpc.body.p_revision,4);
 assert.equal((await request('/api/v1/research-tasks',{...scope,focus:[]})).status,400);
 }finally{await new Promise(r=>server.close(r));}
});

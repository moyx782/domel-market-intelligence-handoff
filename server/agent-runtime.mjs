// Pi agent runtime for the workspace chat.
//
// One agent per request, rooted in a per-project workspace directory. The agent
// gets built-in file tools, optional bash (the CLI switch), every enabled skill
// directory, and every enabled MCP server from the agent configuration.

import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {
 createAgentSession,
 createMcpExtension,
 DefaultResourceLoader,
 SessionManager,
 SettingsManager,
} from '@earendil-works/pi-coding-agent';

export const AGENT_SYSTEM_PROMPT=[
 'You are the Domel research agent. You work inside a local project workspace directory.',
 'Use the workspace files to collect notes, source excerpts and summaries. Keep files small and named clearly.',
 'Use MCP tools and the available skills when they help; cite the source of every factual claim.',
 'Never invent company data, quotations, dates or trade-show schedules. If a tool is unavailable or a source cannot be read, say so.',
 'The structured review UI is still the place where findings are approved; you can prepare evidence for it.',
 'Reply in the language of the user message unless asked otherwise.',
].join(' ');

const BUILTIN_TOOLS=['read','write','edit','grep','find','ls'];

// File tools are all-or-nothing: when disabled the agent keeps only MCP tools,
// so it cannot inspect the workspace either.
export function agentTools(cli){
 if(!cli?.enabled)return ['mcp__*'];
 return [...BUILTIN_TOOLS,...(cli.allowBash?['bash']:[]),'mcp__*'];
}

async function openSessionFile({dir,cwd,model,modelRuntime,loader,tools,agentDir}){
 const sessions=await SessionManager.listAll(dir);
 const latest=sessions.sort((a,b)=>b.modified-a.modified)[0];
 const sessionManager=latest?SessionManager.open(latest.path,dir,cwd):SessionManager.create(cwd,dir);
 const {session}=await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime,
  resourceLoader:loader,
  tools,
  sessionManager,
  settingsManager:SettingsManager.inMemory({compaction:{enabled:false}}),
 });
 return session;
}

export function createAgentRuntime({store,model,modelRuntime,workspaceRoot,agentDir,systemPrompt=AGENT_SYSTEM_PROMPT,transcripts}){
 return async function chat({projectId='general',message,onEvent=()=>{},abortSignal}){
  if(typeof message!=='string'||!message.trim())throw Error('Invalid agent message');
  if(message.length>12000)throw Error('Agent message is too long');
  const workspace=join(workspaceRoot,String(projectId||'general').replace(/[^a-zA-Z0-9_-]/g,'_'));
  const sessions=join(store.sessionsDir,String(projectId||'general').replace(/[^a-zA-Z0-9_-]/g,'_'));
  mkdirSync(workspace,{recursive:true});
  mkdirSync(sessions,{recursive:true});

  const loader=new DefaultResourceLoader({
   cwd:workspace,
   agentDir,
   additionalSkillPaths:store.enabledSkillPaths(),
   additionalExtensionPaths:store.enabledPluginPaths?.() ?? [],
   extensionFactories:[createMcpExtension({
    loadConfig:()=>store.mcpRuntimeConfig(),
    logPath:join(agentDir,'mcp.log'),
    startupWaitMs:4000,
   })],
   noContextFiles:true,
   noPromptTemplates:true,
   noThemes:true,
   systemPrompt,
  });
  await loader.reload();
  const extensionErrors=loader.getExtensions().errors;
  if(extensionErrors.length)onEvent({type:'warning',message:extensionErrors.map(error=>error.error).join('; ')});

  const cli=store.cli();
  const tools=agentTools(cli);
  const session=await openSessionFile({dir:sessions,cwd:workspace,model,modelRuntime,loader,tools,agentDir});
  await session.bindExtensions({});

  const onAbort=()=>{session.abort().catch(()=>{});};
  abortSignal?.addEventListener('abort',onAbort,{once:true});
  const startedAt=new Date().toISOString();
  const toolCalls=[];
  const unsubscribe=session.subscribe(event=>{
   if(event.type==='message_update'&&event.assistantMessageEvent.type==='text_delta'){
    onEvent({type:'delta',text:event.assistantMessageEvent.delta});
   }else if(event.type==='tool_execution_start'){
    toolCalls.push({tool:event.toolName,ok:false,args:safeArgs(event.args)});
    onEvent({type:'tool_start',tool:event.toolName,args:safeArgs(event.args)});
   }else if(event.type==='tool_execution_end'){
    const pending=[...toolCalls].reverse().find(call=>call.tool===event.toolName&&!call.ok);
    if(pending)pending.ok=!event.isError;
    onEvent({type:'tool_end',tool:event.toolName,ok:!event.isError});
   }
  });
  // The runtime keeps the durable transcript: the agent page shows it to every
  // role, including viewers who cannot chat.
  const record=patch=>transcripts?.recordRun({projectId,userText:message,toolCalls,startedAt,finishedAt:new Date().toISOString(),...patch}).catch(()=>{});
  try{
   await session.prompt(message.trim());
   const text=session.getLastAssistantText()??'';
   onEvent({type:'done',text,workspace});
   await record({assistantText:text});
   return {text,workspace};
  }catch(error){
   await record({assistantText:'',error:error instanceof Error?error.message:'Agent run failed'});
   throw error;
  }finally{
   abortSignal?.removeEventListener('abort',onAbort);
   unsubscribe();
   session.dispose();
  }
 };
}

function safeArgs(args){
 try{
  const text=JSON.stringify(args??{});
  return text.length>600?text.slice(0,600)+'…':text;
 }catch{return '';}
}

// Agent configuration and on-disk layout for MCP servers, skills and plugins.
//
// `agent/mcp.json` is the source of truth for MCP servers. Admins may edit it by
// hand, through the API, or through the settings UI; the agent runtime reads the
// file directly. `agent-config.json` keeps role, CLI and skill/plugin metadata.
//
//   .local/agent/mcp.json                  MCP servers (standard mcpServers shape)
//   .local/agent/skills/<slug>/SKILL.md    one directory per skill
//   .local/agent/extensions/<slug>/        Pi extensions (plugins)
//   .local/agent-config.json               role, CLI, skills, plugins

import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const DEFAULT_CLI={enabled:true,allowBash:true};
const EMPTY={role:'admin',cli:DEFAULT_CLI,skills:[],plugins:[],ocr:{provider:'none',localUrl:'',officialBase:'',token:''}};
const NAME=/^[a-zA-Z0-9_-]{1,40}$/;
const EXPOSURES=new Set(['direct','codemode','deferred','hidden']);

const slugify=value=>String(value||'skill').toLowerCase().normalize('NFKD')
 .replace(/[^a-z0-9\u4e00-\u9fa5]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'skill';

function parseSkill(content){
 const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
 const meta={};
 if(match){
  for(const line of match[1].split(/\r?\n/)){
   const pair=/^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
   if(pair)meta[pair[1]]=pair[2].replace(/^["']|["']$/g,'');
  }
 }
 return {meta,body:match?content.slice(match[0].length):content};
}

function renderSkill(name,description,body){
 return `---\nname: ${name}\ndescription: ${description||''}\n---\n\n${body??''}\n`;
}

function normalizeServer(entry){
 if(!entry||typeof entry!=='object')return null;
 const out={...entry};
 out.enabled=entry.enabled!==false;
 out.exposure=EXPOSURES.has(entry.exposure)?entry.exposure:'direct';
 if(Array.isArray(entry.args))out.args=entry.args.map(String);
 if(entry.env&&typeof entry.env==='object')out.env=Object.fromEntries(Object.entries(entry.env).map(([k,v])=>[String(k),String(v)]));
 if(entry.headers&&typeof entry.headers==='object')out.headers=Object.fromEntries(Object.entries(entry.headers).map(([k,v])=>[String(k),String(v)]));
 return out;
}

export function openAgentStore(root){
 const dir=join(root,'agent');
 const skillsDir=join(dir,'skills');
 const extensionsDir=join(dir,'extensions');
 const sessionsDir=join(dir,'sessions');
 const mcpFile=join(dir,'mcp.json');
 const configFile=join(root,'agent-config.json');
 mkdirSync(skillsDir,{recursive:true});
 mkdirSync(extensionsDir,{recursive:true});
 mkdirSync(sessionsDir,{recursive:true});

 let config;
 try{config=JSON.parse(readFileSync(configFile,'utf8'));}catch{config=structuredClone(EMPTY);}
 for(const key of ['skills','plugins'])if(!Array.isArray(config[key]))config[key]=[];
 config.role=['viewer','user','admin','system'].includes(config.role)?config.role:'admin';
 config.cli={...DEFAULT_CLI,...(config.cli||{})};
 config.ocr={provider:'none',localUrl:'',officialBase:'',token:'',...(config.ocr||{})};
 config.ocr.token=String(config.ocr.token||'');

 for(const entry of readdirSync(skillsDir,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const file=join(skillsDir,entry.name,'SKILL.md');
  if(!existsSync(file))continue;
  if(config.skills.some(skill=>skill.slug===entry.name))continue;
  const {meta}=parseSkill(readFileSync(file,'utf8'));
  config.skills.push({id:randomUUID(),slug:entry.name,name:meta.name||entry.name,description:meta.description||'',enabled:true});
 }

 for(const entry of readdirSync(extensionsDir,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  if(config.plugins.some(plugin=>plugin.slug===entry.name))continue;
  config.plugins.push({id:randomUUID(),slug:entry.name,name:entry.name,enabled:true});
 }

 let mcpServers={};
 let mcpMtime=0;

 function readMcpFile(){
  try{
   const stat=statSync(mcpFile);
   if(stat.mtimeMs===mcpMtime)return;
   const parsed=JSON.parse(readFileSync(mcpFile,'utf8'));
   mcpServers={};
   for(const [name,value] of Object.entries(parsed.mcpServers??{})){
    if(!NAME.test(name))continue;
    const normalized=normalizeServer(value);
    if(normalized)mcpServers[name]=normalized;
   }
   mcpMtime=stat.mtimeMs;
  }catch{}
 }

 function writeMcpFile(){
  mkdirSync(dir,{recursive:true});
  writeFileSync(mcpFile,JSON.stringify({mcpServers},null,2),{mode:0o600});
  try{mcpMtime=statSync(mcpFile).mtimeMs;}catch{mcpMtime=0;}
 }

 let configMtime=0;
 try{configMtime=statSync(configFile).mtimeMs;}catch{}

 function persistConfig(){
  mkdirSync(dir,{recursive:true});
  const {mcpServers:_legacy,...rest}=config;
  writeFileSync(configFile,JSON.stringify(rest,null,2),{mode:0o600});
  try{configMtime=statSync(configFile).mtimeMs;}catch{configMtime=0;}
 }

 // The T0 CLI edits agent-config.json while the service may be running.
 // Reload role/CLI/OCR when the file changed so those changes take effect
 // without a restart.
 function refreshSettings(){
  try{
   const stat=statSync(configFile);
   if(stat.mtimeMs===configMtime)return;
   const parsed=JSON.parse(readFileSync(configFile,'utf8'));
   config.role=['viewer','user','admin','system'].includes(parsed.role)?parsed.role:'admin';
   config.cli={...DEFAULT_CLI,...(parsed.cli||{})};
   config.ocr={provider:'none',localUrl:'',officialBase:'',token:'',...(parsed.ocr||{})};
   config.ocr.token=String(config.ocr.token||'');
   configMtime=stat.mtimeMs;
  }catch{}
 }

 readMcpFile();
 if(Object.keys(mcpServers).length===0&&Array.isArray(config.mcpServers)&&config.mcpServers.length){
  for(const server of config.mcpServers){
   if(NAME.test(server.name))mcpServers[server.name]=normalizeServer(server);
  }
  writeMcpFile();
 }
 delete config.mcpServers;
 persistConfig();

 function skillPath(skill){return join(skillsDir,skill.slug);}
 function readSkillBody(skill){
  const file=join(skillPath(skill),'SKILL.md');
  return existsSync(file)?parseSkill(readFileSync(file,'utf8')).body:'';
 }
 function writeSkillFile(skill,body){
  const target=skillPath(skill);
  mkdirSync(target,{recursive:true});
  const existing=existsSync(join(target,'SKILL.md'))?parseSkill(readFileSync(join(target,'SKILL.md'),'utf8')).body:'';
  writeFileSync(join(target,'SKILL.md'),renderSkill(skill.name,skill.description,body??existing));
 }

 return {
  dir,
  skillsDir,
  extensionsDir,
  sessionsDir,
  configFile,
  mcpFile,

  config(){refreshSettings();readMcpFile();return structuredClone({...config,mcpServers:Object.entries(mcpServers).map(([name,value])=>({name,...value}))});},

  publicConfig(){
   refreshSettings();
   readMcpFile();
   const admin=config.role==='admin'||config.role==='system';
   return {
    role:config.role,
    cli:structuredClone(config.cli),
    mcpServers:Object.entries(mcpServers).map(([name,server])=>({
     ...structuredClone(server),
     name,
     transport:server.url?'http':'stdio',
     ...(admin?{}:{env:mask(server.env),headers:mask(server.headers)}),
    })),
    ocr:{provider:config.ocr.provider,localUrl:config.ocr.localUrl,officialBase:config.ocr.officialBase,tokenSet:Boolean(config.ocr.token)},
    skills:config.skills.map(skill=>({...skill,path:skillPath(skill),...(admin?{content:readSkillBody(skill)}:{})})),
    plugins:config.plugins.map(plugin=>({...plugin,path:join(extensionsDir,plugin.slug)})),
   };
  },

  rawMcp(){readMcpFile();return {mcpServers:structuredClone(mcpServers)};},

  replaceMcpConfig(input){
   let parsed=input;
   if(typeof input==='string'){
    try{parsed=JSON.parse(input);}catch{throw Error('mcp.json is not valid JSON');}
   }
   if(!parsed||typeof parsed!=='object'||!parsed.mcpServers||typeof parsed.mcpServers!=='object'||Array.isArray(parsed.mcpServers))throw Error('mcp.json must contain a mcpServers object');
   const next={};
   for(const [name,value] of Object.entries(parsed.mcpServers)){
    if(!NAME.test(name))throw Error('Invalid MCP server name: '+name);
    if(!value||typeof value!=='object')throw Error('Invalid MCP server entry: '+name);
    if(!value.command&&!value.url)throw Error('MCP server needs command or url: '+name);
    next[name]=normalizeServer(value);
   }
   mcpServers=next;
   writeMcpFile();
   return this.rawMcp();
  },

  addMcp(input){
   readMcpFile();
   const name=String(input.name||'').trim();
   if(!NAME.test(name))throw Error('Invalid MCP server name');
   if(mcpServers[name])throw Error('MCP server already exists');
   if(input.transport==='http'){
    if(!/^https?:\/\//.test(String(input.url||'')))throw Error('Invalid MCP URL');
   }else if(!String(input.command||'').trim())throw Error('MCP command is required');
   mcpServers[name]=normalizeServer({
    enabled:input.enabled!==false,
    exposure:input.exposure||'direct',
    ...(input.transport==='http'
     ?{url:String(input.url),headers:cleanMap(input.headers)}
     :{command:String(input.command).trim(),args:Array.isArray(input.args)?input.args.map(String):[],env:cleanMap(input.env)}),
   });
   writeMcpFile();
   return {name,...mcpServers[name]};
  },

  updateMcp(name,patch,{enabledOnly=false}={}){
   readMcpFile();
   const server=mcpServers[name];
   if(!server)throw Error('MCP server not found');
   if(enabledOnly){
    if(typeof patch.enabled!=='boolean')throw Error('Only enabled can be changed');
    server.enabled=patch.enabled;
   }else{
    const next={...server};
    if(patch.command!==undefined)next.command=String(patch.command);
    if(patch.args!==undefined)next.args=Array.isArray(patch.args)?patch.args.map(String):[];
    if(patch.env!==undefined)next.env=cleanMap(patch.env);
    if(patch.url!==undefined)next.url=String(patch.url);
    if(patch.headers!==undefined)next.headers=cleanMap(patch.headers);
    if(typeof patch.enabled==='boolean')next.enabled=patch.enabled;
    if(EXPOSURES.has(patch.exposure))next.exposure=patch.exposure;
    mcpServers[name]=normalizeServer(next);
   }
   writeMcpFile();
   return {name,...mcpServers[name]};
  },

  removeMcp(name){
   readMcpFile();
   if(!mcpServers[name])throw Error('MCP server not found');
   delete mcpServers[name];
   writeMcpFile();
  },

  skillBody(id){
   const skill=config.skills.find(item=>item.id===id);
   if(!skill)throw Error('Skill not found');
   const file=join(skillPath(skill),'SKILL.md');
   return existsSync(file)?parseSkill(readFileSync(file,'utf8')).body:'';
  },

  addSkill(input){
   const name=String(input.name||'').trim();
   if(!name)throw Error('Skill name is required');
   const base=slugify(name);
   let slug=base,index=2;
   while(config.skills.some(skill=>skill.slug===slug)||existsSync(join(skillsDir,slug)))slug=base+'-'+index++;
   const skill={id:randomUUID(),slug,name,description:String(input.description||''),enabled:true};
   writeSkillFile(skill,String(input.content||''));
   config.skills.push(skill);persistConfig();return skill;
  },

  updateSkill(id,patch,{enabledOnly=false}={}){
   const skill=config.skills.find(item=>item.id===id);
   if(!skill)throw Error('Skill not found');
   if(enabledOnly){
    if(typeof patch.enabled!=='boolean')throw Error('Only enabled can be changed');
    skill.enabled=patch.enabled;
   }else{
    if(patch.name!==undefined)skill.name=String(patch.name).trim()||skill.name;
    if(patch.description!==undefined)skill.description=String(patch.description);
    if(typeof patch.enabled==='boolean')skill.enabled=patch.enabled;
    if(patch.content!==undefined)writeSkillFile(skill,String(patch.content));
    else writeSkillFile(skill);
   }
   persistConfig();return skill;
  },

  removeSkill(id){
   const skill=config.skills.find(item=>item.id===id);
   if(!skill)throw Error('Skill not found');
   config.skills=config.skills.filter(item=>item.id!==id);
   rmSync(skillPath(skill),{recursive:true,force:true});
   persistConfig();
  },

  pluginPath(plugin){return join(extensionsDir,plugin.slug);},

  addPlugin(input){
   const name=String(input.name||'').trim();
   if(!name)throw Error('Plugin name is required');
   const base=slugify(name);
   let slug=base,index=2;
   while(config.plugins.some(plugin=>plugin.slug===slug)||existsSync(join(extensionsDir,slug)))slug=base+'-'+index++;
   const dirPath=join(extensionsDir,slug);
   mkdirSync(dirPath,{recursive:true});
   const file=String(input.file||'index.js');
   writeFileSync(join(dirPath,file),String(input.content??'export default function(){};\n'));
   const plugin={id:randomUUID(),slug,name,file,enabled:true};
   config.plugins.push(plugin);persistConfig();return plugin;
  },

  updatePlugin(id,patch,{enabledOnly=false}={}){
   const plugin=config.plugins.find(item=>item.id===id);
   if(!plugin)throw Error('Plugin not found');
   if(enabledOnly){
    if(typeof patch.enabled!=='boolean')throw Error('Only enabled can be changed');
    plugin.enabled=patch.enabled;
   }else{
    if(patch.name!==undefined)plugin.name=String(patch.name).trim()||plugin.name;
    if(typeof patch.enabled==='boolean')plugin.enabled=patch.enabled;
    if(patch.content!==undefined){
     const file=patch.file||plugin.file||'index.js';
     plugin.file=file;
     writeFileSync(join(extensionsDir,plugin.slug,file),String(patch.content));
    }
   }
   persistConfig();return plugin;
  },

  removePlugin(id){
   const plugin=config.plugins.find(item=>item.id===id);
   if(!plugin)throw Error('Plugin not found');
   config.plugins=config.plugins.filter(item=>item.id!==id);
   rmSync(join(extensionsDir,plugin.slug),{recursive:true,force:true});
   persistConfig();
  },

  ocr(){refreshSettings();return structuredClone(config.ocr);},

  setSettings(patch,{allowCli=true}={}){
   if(patch.ocr!==undefined){
    const next={...config.ocr};
    if(patch.ocr.provider!==undefined){
     if(!['none','official','local'].includes(patch.ocr.provider))throw Error('Invalid OCR provider');
     next.provider=patch.ocr.provider;
    }
    for(const key of ['localUrl','officialBase']){
     if(patch.ocr[key]===undefined)continue;
     const value=String(patch.ocr[key]||'').trim();
     if(value){
      const url=new URL(value);
      if(url.protocol!=='https:'&&url.protocol!=='http:')throw Error('OCR base URL must use http or https');
      next[key]=url.href.replace(/\/$/,'');
     }else next[key]='';
    }
    if(patch.ocr.token!==undefined){
     const token=String(patch.ocr.token);
     if(token.length>2000)throw Error('OCR token is too long');
     next.token=token;
    }
    config.ocr=next;
   }
   if(patch.role!==undefined){
    if(!['viewer','user','admin','system'].includes(patch.role))throw Error('Invalid role');
    config.role=patch.role;
   }
   if(patch.cli!==undefined){
    if(!allowCli)throw Error('CLI is managed by the system role');
    if(typeof patch.cli.enabled==='boolean')config.cli.enabled=patch.cli.enabled;
    if(typeof patch.cli.allowBash==='boolean')config.cli.allowBash=patch.cli.allowBash;
   }
   persistConfig();
   return {role:config.role,cli:structuredClone(config.cli),ocr:structuredClone(config.ocr)};
  },

  enabledSkillPaths(){
   return config.skills.filter(skill=>skill.enabled).map(skill=>skillPath(skill)).filter(path=>existsSync(join(path,'SKILL.md')));
  },

  enabledPluginPaths(){
   return config.plugins.filter(plugin=>plugin.enabled).map(plugin=>{
    const dirPath=join(extensionsDir,plugin.slug);
    const file=plugin.file&&existsSync(join(dirPath,plugin.file))?join(dirPath,plugin.file):null;
    return file??dirPath;
   });
  },

  mcpRuntimeConfig(){
   readMcpFile();
   return {
    servers:Object.entries(mcpServers).map(([name,server])=>({
     name,
     source:mcpFile,
     scope:'global',
     config:server.url
      ?{url:server.url,headers:server.headers||{},enabled:server.enabled!==false,exposure:server.exposure||'direct'}
      :{command:server.command,args:server.args||[],env:server.env||{},enabled:server.enabled!==false,exposure:server.exposure||'direct'},
    })),
    errors:[],
   };
  },

  cli(){refreshSettings();return structuredClone(config.cli);},
 };
}

function cleanMap(value){
 if(!value)return {};
 if(typeof value==='string'){
  const out={};
  for(const line of value.split(/\r?\n/)){
   const pair=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
   if(pair)out[pair[1]]=pair[2];
  }
  return out;
 }
 if(typeof value!=='object')return {};
 return Object.fromEntries(Object.entries(value).map(([key,val])=>[String(key),String(val)]));
}

function mask(map){
 if(!map)return map;
 return Object.fromEntries(Object.keys(map).map(key=>[key,'••••••']));
}

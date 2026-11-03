import {useEffect,useState} from 'react';
import {AlertCircle,Check,KeyRound,Save,ShieldCheck,Terminal} from 'lucide-react';
import {backendBase} from './data';
import {useI18n} from './i18n';

type Role='viewer'|'user'|'admin'|'system';
type OcrConfig={provider:'none'|'official'|'local';localUrl:string;officialBase:string;tokenSet:boolean};
type AgentConfig={role:Role;cli:{enabled:boolean;allowBash:boolean};ocr:OcrConfig};

async function request(path:string,init?:RequestInit){
 const response=await fetch(backendBase+path,{...init,headers:{'Content-Type':'application/json',...(init?.headers||{})}});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(payload.error||('Request failed ('+response.status+')'));
 return payload;
}

export default function Settings({onRoleChanged}:{onRoleChanged?:()=>void}){
 const {t}=useI18n();
 const [config,setConfig]=useState<AgentConfig|null>(null);
 const [provider,setProvider]=useState<'none'|'official'|'local'>('none');
 const [endpoint,setEndpoint]=useState('');
 const [token,setToken]=useState('');
 const [clearToken,setClearToken]=useState(false);
 const [role,setRole]=useState<Role>('admin');
 const [cliEnabled,setCliEnabled]=useState(true);
 const [cliBash,setCliBash]=useState(true);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);

 async function load(){
  try{
   const next=await request('/api/v1/agent/config');
   setConfig(next);
   setRole(next.role);
   setCliEnabled(next.cli?.enabled??true);
   setCliBash(next.cli?.allowBash??true);
   const nextProvider=next.ocr?.provider??'none';
   setProvider(nextProvider);
   setEndpoint(nextProvider==='local'
    ?(next.ocr?.localUrl||'http://127.0.0.1:8000')
    :(nextProvider==='official'?(next.ocr?.officialBase||'https://mineru.net/api/v4'):''));
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 useEffect(()=>{void load();},[]);

 const isAdmin=config?.role==='admin'||config?.role==='system';
 const isSystem=config?.role==='system';

 async function saveRole(){
  setBusy(true);setError('');setNotice('');
  try{
   await request('/api/v1/agent/settings',{method:'PATCH',body:JSON.stringify({role})});
   await load();onRoleChanged?.();
   setNotice(t('Role updated'));
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }

 async function saveCli(){
  setBusy(true);setError('');setNotice('');
  try{
   await request('/api/v1/agent/settings',{method:'PATCH',body:JSON.stringify({cli:{enabled:cliEnabled,allowBash:cliBash}})});
   await load();
   setNotice(t('Tools updated'));
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }

 async function saveOcr(){
  setBusy(true);setError('');setNotice('');
  try{
   const ocr:{provider:string;localUrl?:string;officialBase?:string;token?:string}={provider};
   if(provider==='local')ocr.localUrl=endpoint;
   if(provider==='official')ocr.officialBase=endpoint;
   if(clearToken)ocr.token='';
   else if(token)ocr.token=token;
   await request('/api/v1/agent/settings',{method:'PATCH',body:JSON.stringify({ocr})});
   setToken('');setClearToken(false);
   await load();
   setNotice(t('Saved'));
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }

 if(!config)return <section className="panel padded"><p className="muted">{t('Loading…')}</p></section>;

 return <div className="settings-page">
  <div className="page-heading"><div><h1>{t('Settings')}</h1><p>{t('Manage roles, document parsing and integrations for this workspace.')}</p></div><span className="step-label">{config.role}</span></div>
  {!isAdmin&&<div className="alert"><AlertCircle size={17}/>{t('Only admins can change workspace settings.')}</div>}
  {error&&<div role="alert" className="alert error">{t(error)}</div>}
  {notice&&<div role="status" className="alert success"><Check size={17}/>{notice}</div>}

  <section className="panel padded">
   <div className="settings-section-head"><ShieldCheck size={18}/><div><h2>{t('Role & access')}</h2><p>{t('Admin manages roles; the system (T0) role is only set from the local CLI.')}</p></div></div>
   <div className="settings-grid">
    <label>{t('Workspace role')}
     {config.role==='system'
      ? <input value="system (T0)" readOnly/>
      : <select value={role} onChange={e=>setRole(e.target.value as Role)} disabled={!isAdmin}>
         <option value="admin">admin</option>
         <option value="user">user</option>
         <option value="viewer">viewer</option>
        </select>}
    </label>
   </div>
   {isAdmin&&config.role!=='system'&&<><p className="small">{t('Downgrading a role requires the local CLI to restore admin access.')}</p><div className="review-actions"><button className="primary" onClick={()=>void saveRole()} disabled={busy}><Save size={16}/>{t('Save role')}</button></div></>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><Terminal size={18}/><div><h2>{t('Agent tools')}</h2><p>{t('Controls what the agent can do in its local workspace. Only the system (T0) role can change these switches.')}</p></div></div>
   <div className="settings-grid">
    <label>{t('File read/write')}
     <select value={cliEnabled?'on':'off'} onChange={e=>setCliEnabled(e.target.value==='on')} disabled={!isSystem}>
      <option value="on">{t('Enabled')}</option>
      <option value="off">{t('Disabled')}</option>
     </select>
    </label>
    <label>{t('Shell commands')}
     <select value={cliBash?'on':'off'} onChange={e=>setCliBash(e.target.value==='on')} disabled={!isSystem || !cliEnabled}>
      <option value="on">{t('Enabled')}</option>
      <option value="off">{t('Disabled')}</option>
     </select>
    </label>
   </div>
   {isSystem&&<div className="review-actions"><button className="primary" onClick={()=>void saveCli()} disabled={busy}><Save size={16}/>{t('Save tools')}</button></div>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><KeyRound size={18}/><div><h2>{t('Document parsing')}</h2><p>{t('MinerU converts PDFs and scanned exhibitor lists. Links and availability are shown even when parsing is disabled.')}</p></div></div>
   <div className="settings-grid">
    <label>{t('OCR provider')}
     <select value={provider} onChange={e=>{
      const next=e.target.value as 'none'|'official'|'local';
      setProvider(next);
      if(next==='official')setEndpoint('https://mineru.net/api/v4');
      else if(next==='local')setEndpoint('http://127.0.0.1:8000');
      else setEndpoint('');
     }} disabled={!isAdmin}>
      <option value="none">{t('Disabled')}</option>
      <option value="official">{t('MinerU official API')}</option>
      <option value="local">{t('Self-hosted MinerU')}</option>
     </select>
    </label>
    <label>{t('API endpoint')}
     <input value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder={provider==='local'?'http://127.0.0.1:8000':'https://mineru.net/api/v4'} disabled={!isAdmin||provider==='none'}/>
    </label>
    <label>{t('API token')}
     <input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="new-password" placeholder={config.ocr.tokenSet?t('Configured — leave blank to keep'):t('Not configured')} disabled={!isAdmin||provider!=='official'}/>
    </label>
   </div>
   <p className="small">{t('Choosing a provider fills its default endpoint; you can override it.')}</p>
   <p className="small">{t('Tokens are write-only: they can be replaced or cleared, but never displayed again.')}</p>
   {isAdmin&&<div className="review-actions">
    <button className="primary" onClick={()=>void saveOcr()} disabled={busy}><Save size={16}/>{t('Save settings')}</button>
    {config.ocr.tokenSet&&<button className="secondary" onClick={()=>setClearToken(true)} disabled={busy}>{t('Clear token')}</button>}
   </div>}
  </section>
 </div>;
}

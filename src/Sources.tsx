import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertCircle,Ban,Check,Globe,LoaderCircle,Pencil,Play,Plus,RefreshCw,Trash2,X} from 'lucide-react';
import {createSource,deleteSource,listSources,runSource,updateSource} from './api';
import {locale,useI18n} from './i18n';
import './messages-tasks';
import type {EventRegion,Role,SourceEntry,SourceStats,SourceStatus,SourceType} from './types';

const TYPES:SourceType[]=['venue','association','organizer','media','site','rss','sitemap'];
const TYPE_LABELS:Record<SourceType,string>={venue:'Venue',association:'Association',organizer:'Organizer',media:'Media',site:'Site',rss:'RSS feed',sitemap:'Sitemap'};
const REGIONS:EventRegion[]=['cn','eu','global'];
const REGION_LABELS:Record<EventRegion,string>={cn:'China',eu:'Europe',global:'Global'};
const STATUSES:SourceStatus[]=['idle','running','error','paused','manual'];
const STATUS_LABELS:Record<SourceStatus,string>={idle:'Idle',running:'Running',error:'Error',paused:'Paused',manual:'Manual'};

type SourceForm={url:string;title:string;type:SourceType;region:EventRegion;priority:number;intervalSec:number};
const EMPTY_FORM:SourceForm={url:'',title:'',type:'venue',region:'cn',priority:1,intervalSec:3600};

function errorMessage(cause:unknown){
 return cause instanceof Error?cause.message:String(cause);
}

function isHttpsUrl(value:string){
 try{
  const parsed=new URL(value.trim());
  return parsed.protocol==='https:'&&!parsed.username&&!parsed.password;
 }catch{
  return false;
 }
}

function parseIso(value:string|null){
 if(!value)return null;
 const time=Date.parse(value);
 return Number.isFinite(time)?time:null;
}

function formatDateTime(value:number|null,dateTag:string){
 if(value===null||!Number.isFinite(value))return '—';
 return new Date(value).toLocaleString(dateTag,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

function formatInterval(seconds:number){
 if(seconds<60)return seconds+' s';
 if(seconds<3600)return Math.round(seconds/60)+' min';
 const hours=seconds/3600;
 return (Number.isInteger(hours)?hours:hours.toFixed(1))+' h';
}

export default function Sources({role}:{role:Role}){
 const {t,lang}=useI18n();
 const dateTag=locale(lang);
 const canManage=role==='admin'||role==='system';
 const canOperate=role==='user'||canManage;
 const [sources,setSources]=useState<SourceEntry[]|null>(null);
 const [error,setError]=useState('');
 const [actionError,setActionError]=useState('');
 const [notice,setNotice]=useState('');
 const [regionFilter,setRegionFilter]=useState<'all'|EventRegion>('all');
 const [typeFilter,setTypeFilter]=useState<'all'|SourceType>('all');
 const [statusFilter,setStatusFilter]=useState<'all'|SourceStatus>('all');
 const [enabledFilter,setEnabledFilter]=useState<'all'|'enabled'|'disabled'>('all');
 const [showCreate,setShowCreate]=useState(false);
 const [editing,setEditing]=useState<SourceEntry|null>(null);
 const [form,setForm]=useState<SourceForm>(EMPTY_FORM);
 const [formError,setFormError]=useState('');
 const [saving,setSaving]=useState(false);
 const [busyId,setBusyId]=useState('');
 const mounted=useRef(true);
 const timers=useRef<number[]>([]);

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const id of timers.current)window.clearTimeout(id);timers.current=[];};},[]);

 const refresh=useCallback(async()=>{
  try{
   const payload=await listSources();
   if(!mounted.current)return;
   setSources(payload.sources);
   setError('');
  }catch(cause){
   if(mounted.current)setError(errorMessage(cause));
  }
 },[]);

 useEffect(()=>{void refresh();},[refresh]);

 useEffect(()=>{
  if(!notice)return;
  const timer=setTimeout(()=>setNotice(''),5000);
  return()=>clearTimeout(timer);
 },[notice]);

 useEffect(()=>{
  if(!editing)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setEditing(null);};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[editing]);

 const all=sources??[];
 const stats:SourceStats={total:all.length,enabled:all.filter(source=>source.enabled).length,error:all.filter(source=>source.status==='error').length,paused:all.filter(source=>source.status==='paused').length};
 const visible=useMemo(()=>all.filter(source=>
  (regionFilter==='all'||source.region===regionFilter)&&
  (typeFilter==='all'||source.type===typeFilter)&&
  (statusFilter==='all'||source.status===statusFilter)&&
  (enabledFilter==='all'||(enabledFilter==='enabled')===source.enabled)
 ),[all,regionFilter,typeFilter,statusFilter,enabledFilter]);
 const loading=sources===null&&!error;
 const filtersActive=regionFilter!=='all'||typeFilter!=='all'||statusFilter!=='all'||enabledFilter!=='all';

 function resetFilters(){
  setRegionFilter('all');
  setTypeFilter('all');
  setStatusFilter('all');
  setEnabledFilter('all');
 }

 async function toggle(source:SourceEntry){
  setBusyId(source.id);
  setActionError('');
  try{
   // Only the enabled field is sent: user roles may switch sources but not edit them.
   const updated=await updateSource(source.id,{enabled:!source.enabled});
   if(!mounted.current)return;
   setSources(previous=>(previous??[]).map(item=>item.id===updated.id?updated:item));
   setNotice(source.enabled?t('Source disabled.'):t('Source enabled.'));
  }catch(cause){
   if(mounted.current)setActionError(errorMessage(cause));
  }finally{
   if(mounted.current)setBusyId('');
  }
 }

 async function run(source:SourceEntry){
  setBusyId(source.id);
  setActionError('');
  try{
   await runSource(source.id);
   if(!mounted.current)return;
   setNotice(t('Source run queued. Track it on the Tasks page.'));
   const timer=window.setTimeout(()=>{void refresh();},2500);
   timers.current.push(timer);
  }catch(cause){
   if(mounted.current)setActionError(errorMessage(cause));
  }finally{
   if(mounted.current)setBusyId('');
  }
 }

 async function submitCreate(){
  setFormError('');
  const url=form.url.trim();
  if(!isHttpsUrl(url)){setFormError(t('Enter a valid HTTPS URL without credentials.'));return;}
  if(!Number.isInteger(form.intervalSec)||form.intervalSec<30){setFormError(t('Interval must be at least 30 seconds.'));return;}
  if(!Number.isInteger(form.priority)||form.priority<0||form.priority>3){setFormError(t('Priority must be between 0 and 3.'));return;}
  setSaving(true);
  try{
   await createSource({url,title:form.title.trim()||undefined,type:form.type,region:form.region,priority:form.priority,intervalSec:form.intervalSec});
   if(!mounted.current)return;
   setNotice(t('Source created.'));
   setForm(EMPTY_FORM);
   setShowCreate(false);
   await refresh();
  }catch(cause){
   if(mounted.current)setFormError(errorMessage(cause));
  }finally{
   if(mounted.current)setSaving(false);
  }
 }

 async function submitEdit(){
  if(!editing)return;
  setFormError('');
  if(!Number.isInteger(editing.intervalSec)||editing.intervalSec<30){setFormError(t('Interval must be at least 30 seconds.'));return;}
  if(!Number.isInteger(editing.priority)||editing.priority<0||editing.priority>3){setFormError(t('Priority must be between 0 and 3.'));return;}
  setSaving(true);
  try{
   const updated=await updateSource(editing.id,{intervalSec:editing.intervalSec,priority:editing.priority});
   if(!mounted.current)return;
   setSources(previous=>(previous??[]).map(item=>item.id===updated.id?updated:item));
   setNotice(t('Source updated.'));
   setEditing(null);
  }catch(cause){
   if(mounted.current)setFormError(errorMessage(cause));
  }finally{
   if(mounted.current)setSaving(false);
  }
 }

 async function remove(source:SourceEntry){
  if(!window.confirm(t('Delete this source? Its scheduled collection will stop.')))return;
  setBusyId(source.id);
  setActionError('');
  try{
   await deleteSource(source.id);
   if(!mounted.current)return;
   setSources(previous=>(previous??[]).filter(item=>item.id!==source.id));
   setNotice(t('Source deleted.'));
  }catch(cause){
   if(mounted.current)setActionError(errorMessage(cause));
  }finally{
   if(mounted.current)setBusyId('');
  }
 }

 return <div className="sources-page">
  <div className="page-heading">
   <div>
    <div className="eyebrow">{t('SOURCE REGISTRY')}</div>
    <h1>{t('Sources')}</h1>
    <p>{t('Websites the scheduler collects market events from.')}</p>
   </div>
   <div className="heading-actions">
    <button className="secondary" onClick={()=>void refresh()}><RefreshCw size={15}/>{t('Refresh')}</button>
    {canManage&&<button className="primary" onClick={()=>{setShowCreate(!showCreate);setEditing(null);setFormError('');setForm(EMPTY_FORM);}}><Plus size={16}/>{t('Add source')}</button>}
   </div>
  </div>

  {notice&&<div role="status" className="alert success"><Check size={17}/>{notice}</div>}
  {error&&sources!==null&&<div role="alert" className="alert error"><AlertCircle size={17}/>{t(error)}<button aria-label={t('Dismiss error')} onClick={()=>setError('')}><X size={16}/></button></div>}
  {actionError&&<div role="alert" className="alert error"><AlertCircle size={17}/>{t(actionError)}<button aria-label={t('Dismiss error')} onClick={()=>setActionError('')}><X size={16}/></button></div>}

  {!canManage&&<div className="alert">
   <AlertCircle size={17}/>
   {role==='viewer'?t('Read-only role: you can view sources but cannot change them.'):t('You can enable, disable and run sources. Ask an admin to add, edit or delete.')}
  </div>}

  <div className="stats source-stats">
   <div className="stat">
    <div>{t('Total sources')}<Globe size={17}/></div>
    <strong>{stats.total.toString().padStart(2,'0')}</strong>
    <small>{t('In the registry')}</small>
   </div>
   <div className="stat">
    <div>{t('Enabled')}<Check size={17}/></div>
    <strong>{stats.enabled.toString().padStart(2,'0')}</strong>
    <small>{t('Scheduled collection on')}</small>
   </div>
   <div className="stat">
    <div>{t('With errors')}<AlertCircle size={17}/></div>
    <strong>{stats.error.toString().padStart(2,'0')}</strong>
    <small>{t('Last run failed')}</small>
   </div>
   <div className="stat">
    <div>{t('Paused')}<Ban size={17}/></div>
    <strong>{stats.paused.toString().padStart(2,'0')}</strong>
    <small>{t('Stopped after errors')}</small>
   </div>
  </div>

  {showCreate&&canManage&&<section className="panel padded source-form">
   <h2>{t('Add a source')}</h2>
   <p className="small">{t('New sources start enabled and run on their interval.')}</p>
   <form noValidate onSubmit={event=>{event.preventDefault();void submitCreate();}}>
    <div className="source-form-grid">
     <label className="wide-field">{t('Source URL')}<input type="url" required value={form.url} placeholder="https://…" onChange={event=>setForm({...form,url:event.target.value})}/></label>
     <label>{t('Title (optional)')}<input value={form.title} onChange={event=>setForm({...form,title:event.target.value})}/></label>
     <label>{t('Type')}<select value={form.type} onChange={event=>setForm({...form,type:event.target.value as SourceType})}>
      {TYPES.map(type=><option key={type} value={type}>{t(TYPE_LABELS[type])}</option>)}
     </select></label>
     <label>{t('Region')}<select value={form.region} onChange={event=>setForm({...form,region:event.target.value as EventRegion})}>
      {REGIONS.map(region=><option key={region} value={region}>{t(REGION_LABELS[region])}</option>)}
     </select></label>
     <label>{t('Priority')}<input type="number" min={0} max={3} step={1} value={form.priority} onChange={event=>setForm({...form,priority:Number(event.target.value)})}/></label>
     <label>{t('Interval (seconds)')}<input type="number" min={30} step={60} value={form.intervalSec} onChange={event=>setForm({...form,intervalSec:Number(event.target.value)})}/></label>
    </div>
    <p className="small">{t('Minimum 30 seconds.')}</p>
    {formError&&<p role="alert" className="validation">{formError}</p>}
    <div className="source-form-actions">
     <button type="submit" className="primary" disabled={saving}>{saving?t('Creating…'):t('Create source')}</button>
     <button type="button" className="secondary" disabled={saving} onClick={()=>{setShowCreate(false);setFormError('');setForm(EMPTY_FORM);}}>{t('Cancel')}</button>
    </div>
   </form>
  </section>}

  <section className="panel">
   <div className="panel-heading">
    <div>
     <h2>{t('Sources')} <span className="count">{visible.length}</span></h2>
     <p>{t('Sources run on a schedule. Run now queues a collection task immediately.')}</p>
    </div>
    <div className="tools source-filters">
     <div className="segmented" role="group" aria-label={t('Filter source enabled state')}>
      {(['all','enabled','disabled'] as const).map(option=><button key={option} className={enabledFilter===option?'active':''} aria-pressed={enabledFilter===option} onClick={()=>setEnabledFilter(option)}>
       {option==='all'?t('All'):option==='enabled'?t('Enabled'):t('Disabled')}
      </button>)}
     </div>
     <select aria-label={t('Filter source region')} value={regionFilter} onChange={event=>setRegionFilter(event.target.value as 'all'|EventRegion)}>
      <option value="all">{t('All regions')}</option>
      {REGIONS.map(region=><option key={region} value={region}>{t(REGION_LABELS[region])}</option>)}
     </select>
     <select aria-label={t('Filter source type')} value={typeFilter} onChange={event=>setTypeFilter(event.target.value as 'all'|SourceType)}>
      <option value="all">{t('All types')}</option>
      {TYPES.map(type=><option key={type} value={type}>{t(TYPE_LABELS[type])}</option>)}
     </select>
     <select aria-label={t('Filter source status')} value={statusFilter} onChange={event=>setStatusFilter(event.target.value as 'all'|SourceStatus)}>
      <option value="all">{t('All statuses')}</option>
      {STATUSES.map(status=><option key={status} value={status}>{t(STATUS_LABELS[status])}</option>)}
     </select>
    </div>
   </div>

   {loading&&<div className="empty"><LoaderCircle className="spin" size={28}/><h2>{t('Loading sources…')}</h2></div>}

   {!loading&&sources===null&&<div className="padded">
    <div role="alert" className="alert error"><AlertCircle size={17}/>{t(error||'Unable to load sources.')}<button className="secondary" onClick={()=>void refresh()}>{t('Try again')}</button></div>
   </div>}

   {!loading&&sources!==null&&!visible.length&&<div className="empty">
    <Globe size={30}/>
    <h2>{all.length?t('No sources match the current filters.'):t('No sources registered yet.')}</h2>
    <p>{all.length?t('Adjust the region, type, status or enabled filter to see more sources.'):canManage?t('Add a source to start collecting market events on a schedule.'):t('No sources have been registered yet. Ask an admin to add one.')}</p>
    {filtersActive&&<button className="secondary" onClick={resetFilters}>{t('Clear filters')}</button>}
   </div>}

   {!loading&&sources!==null&&visible.length>0&&<div className="table-wrap">
    <table className="sources-table">
     <thead><tr>
      <th>{t('SOURCE')}</th>
      <th>{t('TYPE')}</th>
      <th>{t('REGION')}</th>
      <th>{t('PRIORITY')}</th>
      <th>{t('INTERVAL')}</th>
      <th>{t('NEXT RUN')}</th>
      <th>{t('STATUS')}</th>
      <th>{t('ENABLED')}</th>
      {canOperate&&<th>{t('ACTIONS')}</th>}
     </tr></thead>
     <tbody>{visible.map(source=><tr key={source.id}>
      <td>
       <div className="source-name">
        <strong>{source.title||source.domain}</strong>
        <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
        <small>{source.domain}</small>
       </div>
      </td>
      <td>{t(TYPE_LABELS[source.type])}</td>
      <td>{t(REGION_LABELS[source.region])}</td>
      <td><span className={'priority p'+source.priority}>{'P'+source.priority}</span></td>
      <td title={source.intervalSec+' s'}>{formatInterval(source.intervalSec)}</td>
      <td>{formatDateTime(parseIso(source.nextRunAt),dateTag)}</td>
      <td className="source-status-cell">
       <span className={'badge '+source.status}>{t(STATUS_LABELS[source.status])}</span>
       {source.lastError&&<small className="source-error" title={source.lastError}>{source.lastError}</small>}
      </td>
      <td>
       <label className="switch">
        <input type="checkbox" checked={source.enabled} disabled={!canOperate||busyId===source.id} aria-label={t('Toggle source')+' '+(source.title||source.domain)} onChange={()=>void toggle(source)}/>
        <span className="switch-track" aria-hidden="true"/>
       </label>
      </td>
      {canOperate&&<td>
       <div className="source-actions">
        <button className="secondary" disabled={busyId===source.id} aria-label={t('Run now')+' '+(source.title||source.domain)} onClick={()=>void run(source)}><Play size={13}/>{t('Run now')}</button>
        {canManage&&<button className="secondary icon-only" disabled={busyId===source.id} aria-label={t('Edit source')+' '+(source.title||source.domain)} onClick={()=>{setEditing(source);setShowCreate(false);setFormError('');}}><Pencil size={14}/></button>}
        {canManage&&<button className="reject icon-only" disabled={busyId===source.id} aria-label={t('Delete source')+' '+(source.title||source.domain)} onClick={()=>void remove(source)}><Trash2 size={14}/></button>}
       </div>
      </td>}
     </tr>)}</tbody>
    </table>
   </div>}
  </section>

  {editing&&<div className="modal-backdrop" role="presentation" onClick={()=>setEditing(null)}>
   <section role="dialog" aria-modal="true" aria-label={t('Edit interval and priority')} className="modal source-edit-modal" onClick={event=>event.stopPropagation()}>
    <button className="modal-close" aria-label={t('Close')} onClick={()=>setEditing(null)}><X size={18}/></button>
    <div className="eyebrow">{t('SOURCE REGISTRY')}</div>
    <h2>{t('Edit interval and priority')}</h2>
    <p className="small">{editing.title||editing.domain} · {editing.url}</p>
    <div className="form-two">
     <label>{t('Interval (seconds)')}<input type="number" min={30} step={60} value={editing.intervalSec} onChange={event=>setEditing({...editing,intervalSec:Number(event.target.value)})}/></label>
     <label>{t('Priority')}<input type="number" min={0} max={3} step={1} value={editing.priority} onChange={event=>setEditing({...editing,priority:Number(event.target.value)})}/></label>
    </div>
    <p className="small">{t('Minimum 30 seconds.')}</p>
    {formError&&<p role="alert" className="validation">{formError}</p>}
    <div className="source-edit-actions">
     <button className="secondary" onClick={()=>setEditing(null)}>{t('Cancel')}</button>
     <button className="primary" disabled={saving} onClick={()=>void submitEdit()}>{saving?t('Saving…'):t('Save changes')}</button>
    </div>
   </section>
  </div>}
 </div>;
}

import './messages-exhibition';
import {Fragment,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertCircle,Ban,Check,Clock,ListChecks,LoaderCircle,RefreshCw,RotateCcw,WifiOff,X} from 'lucide-react';
import {cancelTask,getTasks,retryTask,streamTasks} from './api';
import {locale,useI18n} from './i18n';
import './messages-tasks';
import type {Role,Task,TaskKind,TaskState,TaskStats} from './types';

const STATES:TaskState[]=['queued','running','succeeded','failed','cancelled'];
const KINDS:TaskKind[]=['exhibition.capture','exhibition.analyse','event.discover','event.enrich','source.collect','project.research','project.extract'];
const STATE_LABELS:Record<TaskState,string>={queued:'Queued',running:'Running',succeeded:'Succeeded',failed:'Failed',cancelled:'Cancelled'};
const KIND_LABELS:Record<TaskKind,string>={'exhibition.capture':'Exhibition full capture','exhibition.analyse':'Post-collection screening','event.discover':'Event discovery','event.enrich':'Event enrichment','source.collect':'Source collection','project.research':'Project research','project.extract':'Project extraction'};

function errorMessage(cause:unknown){
 return cause instanceof Error?cause.message:String(cause);
}

function formatDateTime(value:number|null,dateTag:string){
 if(value===null||!Number.isFinite(value))return '—';
 return new Date(value).toLocaleString(dateTag,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function parseTime(value:string){
 const parsed=Date.parse(value);
 return Number.isFinite(parsed)?parsed:null;
}

// Compact, locale-neutral durations: they read the same in both UI languages.
function formatDuration(ms:number|null){
 if(ms===null||!Number.isFinite(ms)||ms<0)return '—';
 if(ms<1000)return Math.round(ms)+' ms';
 const seconds=Math.round(ms/1000);
 if(seconds<60)return seconds+' s';
 const minutes=Math.floor(seconds/60);
 if(minutes<60)return seconds%60?minutes+' m '+seconds%60+' s':minutes+' m';
 const hours=Math.floor(minutes/60);
 return minutes%60?hours+' h '+minutes%60+' m':hours+' h';
}

function taskDuration(task:Task,now:number){
 if(task.startedAt===null)return null;
 const end=task.finishedAt??(task.state==='running'?now:null);
 return end===null?null:end-task.startedAt;
}

function jsonText(value:unknown){
 try{return JSON.stringify(value,null,2)??String(value);}catch{return String(value);}
}

function countStats(tasks:Task[]):TaskStats{
 const counts:TaskStats={queued:0,running:0,succeeded:0,failed:0,cancelled:0};
 for(const task of tasks)counts[task.state]=(counts[task.state]??0)+1;
 return counts;
}

// The stream sends one task per update; the queue keeps the rest of the list.
function upsertTask(tasks:Task[],task:Task){
 const index=tasks.findIndex(item=>item.id===task.id);
 if(index<0)return [task,...tasks];
 if(tasks[index].updatedAt>task.updatedAt)return tasks;
 const next=tasks.slice();
 next[index]=task;
 return next;
}

// A polling response may be older than the last streamed event; only let newer
// copies overwrite what the page already shows.
function mergeTaskLists(current:Task[],incoming:Task[]){
 const merged=new Map(current.map(task=>[task.id,task]));
 for(const task of incoming){
  const existing=merged.get(task.id);
  if(!existing||task.updatedAt>=existing.updatedAt)merged.set(task.id,task);
 }
 return [...merged.values()];
}

export default function Tasks({role}:{role:Role}){
 const {t,lang}=useI18n();
 const dateTag=locale(lang);
 const canWrite=role==='user'||role==='admin'||role==='system';
 const [tasks,setTasks]=useState<Task[]|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [live,setLive]=useState(true);
 const [stateFilter,setStateFilter]=useState<'all'|TaskState>('all');
 const [kindFilter,setKindFilter]=useState<'all'|TaskKind>('all');
 const [selectedId,setSelectedId]=useState('');
 const [busyId,setBusyId]=useState('');
 const [now,setNow]=useState(()=>Date.now());
 const mounted=useRef(true);

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);

 const refresh=useCallback(async()=>{
  try{
   const payload=await getTasks();
   if(!mounted.current)return;
   setTasks(previous=>previous?mergeTaskLists(previous,payload.tasks):payload.tasks);
   setError('');
  }catch(cause){
   if(mounted.current)setError(errorMessage(cause));
  }
 },[]);

 // Load once, then follow the SSE stream; task events overwrite by id so the
 // statistics and the detail panel stay live without re-fetching the list.
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{
  const close=streamTasks(event=>{
   if(!mounted.current)return;
   setLive(true);
   if(event.type==='snapshot')setTasks(event.tasks);
   else setTasks(previous=>upsertTask(previous??[],event.task));
  },()=>{
   if(!mounted.current)return;
   setLive(false);
   void refresh();
  });
  return close;
 },[refresh]);

 // EventSource retries on its own; while it is down poll so the page stays current.
 useEffect(()=>{
  if(live)return;
  const timer=setInterval(()=>{void refresh();},3000);
  return()=>clearInterval(timer);
 },[live,refresh]);

 const hasRunning=tasks?.some(task=>task.state==='running')??false;
 useEffect(()=>{
  if(!hasRunning)return;
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[hasRunning]);

 useEffect(()=>{
  if(!notice)return;
  const timer=setTimeout(()=>setNotice(''),5000);
  return()=>clearTimeout(timer);
 },[notice]);

 const allTasks=tasks??[];
 const stats=useMemo(()=>countStats(allTasks),[allTasks]);
 const visible=useMemo(()=>allTasks
  .filter(task=>stateFilter==='all'||task.state===stateFilter)
  .filter(task=>kindFilter==='all'||task.kind===kindFilter)
  .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id)),[allTasks,stateFilter,kindFilter]);
 const selected=selectedId?allTasks.find(task=>task.id===selectedId)??null:null;
 const loading=tasks===null&&!error;
 const filtersActive=stateFilter!=='all'||kindFilter!=='all';

 useEffect(()=>{
  if(selectedId&&!selected)setSelectedId('');
 },[selectedId,selected]);

 async function act(task:Task,action:'cancel'|'retry'){
  setBusyId(task.id+':'+action);
  setError('');
  try{
   const updated=action==='cancel'?await cancelTask(task.id):await retryTask(task.id);
   if(!mounted.current)return;
   setTasks(previous=>upsertTask(previous??[],updated));
   setNotice(action==='cancel'?t('Task cancelled.'):t('Task queued for another attempt.'));
   void refresh();
  }catch(cause){
   if(mounted.current)setError(errorMessage(cause));
  }finally{
   if(mounted.current)setBusyId('');
  }
 }

 const stateCards=[
  {key:'queued' as const,label:t('Queued'),note:t('Waiting in queue'),value:stats.queued,icon:<Clock size={17}/>},
  {key:'running' as const,label:t('Running'),note:t('In progress now'),value:stats.running,icon:<LoaderCircle size={17}/>},
  {key:'succeeded' as const,label:t('Succeeded'),note:t('Completed successfully'),value:stats.succeeded,icon:<Check size={17}/>},
  {key:'failed' as const,label:t('Failed'),note:t('Needs attention'),value:stats.failed,icon:<AlertCircle size={17}/>},
  {key:'cancelled' as const,label:t('Cancelled'),note:t('Stopped before completion'),value:stats.cancelled,icon:<Ban size={17}/>},
 ];

 return <div className="tasks-page">
  <div className="page-heading">
   <div>
    <div className="eyebrow">{t('TASK QUEUE')}</div>
    <h1>{t('Task queue')}</h1>
    <p>{t('Live progress for collection, discovery and research jobs.')}</p>
   </div>
   <div className="heading-actions">
    <span className={'live-pill '+(live?'live':'polling')}>
     {live?<span className="dot" aria-hidden="true"/>:<WifiOff size={13}/>}
     {live?t('Live updates'):t('Polling every 3 seconds')}
    </span>
    <button className="secondary" onClick={()=>void refresh()}><RefreshCw size={15}/>{t('Refresh')}</button>
   </div>
  </div>

  {notice&&<div role="status" className="alert success"><Check size={17}/>{notice}</div>}
  {error&&tasks!==null&&<div role="alert" className="alert error"><AlertCircle size={17}/>{t(error)}<button aria-label={t('Dismiss error')} onClick={()=>setError('')}><X size={16}/></button></div>}

  <div className="stats task-stats">
   {stateCards.map(card=><div className="stat" key={card.key}>
    <div>{card.label}{card.icon}</div>
    <strong>{card.value.toString().padStart(2,'0')}</strong>
    <small>{card.note}</small>
   </div>)}
  </div>

  <section className="panel">
   <div className="panel-heading">
    <div>
     <h2>{t('Tasks')} <span className="count">{visible.length}</span></h2>
     <p>{t('Select a task to inspect its payload, result and log.')}</p>
    </div>
    <div className="tools task-filters">
     <div className="segmented" role="group" aria-label={t('Filter task status')}>
      {(['all',...STATES] as const).map(state=><button key={state} className={stateFilter===state?'active':''} aria-pressed={stateFilter===state} onClick={()=>setStateFilter(state)}>
       {state==='all'?t('All'):t(STATE_LABELS[state])} <span>{state==='all'?allTasks.length:stats[state]??0}</span>
      </button>)}
     </div>
     <select aria-label={t('Filter task kind')} value={kindFilter} onChange={event=>setKindFilter(event.target.value as 'all'|TaskKind)}>
      <option value="all">{t('All kinds')}</option>
      {KINDS.map(kind=><option key={kind} value={kind}>{t(KIND_LABELS[kind])}</option>)}
     </select>
    </div>
   </div>

   {loading&&<div className="empty"><LoaderCircle className="spin" size={28}/><h2>{t('Loading tasks…')}</h2></div>}

   {!loading&&tasks===null&&<div className="padded">
    <div role="alert" className="alert error"><AlertCircle size={17}/>{t(error||'Unable to load tasks.')}<button className="secondary" onClick={()=>void refresh()}>{t('Try again')}</button></div>
   </div>}

   {!loading&&tasks!==null&&!visible.length&&<div className="empty">
    <ListChecks size={30}/>
    <h2>{allTasks.length?t('No tasks match the current filters.'):t('No tasks yet.')}</h2>
    <p>{allTasks.length?t('Adjust the status or kind filter to see more tasks.'):t('Queue an event discovery or source collection to see live progress here.')}</p>
    {filtersActive&&<button className="secondary" onClick={()=>{setStateFilter('all');setKindFilter('all');}}>{t('Clear filters')}</button>}
   </div>}

   {!loading&&tasks!==null&&visible.length>0&&<div className="table-wrap">
    <table className="task-table">
     <thead><tr>
      <th>{t('TASK / KIND')}</th>
      <th>{t('STATUS')}</th>
      <th>{t('PROGRESS')}</th>
      <th>{t('RELATED')}</th>
      <th>{t('ATTEMPTS')}</th>
      <th>{t('CREATED')}</th>
      <th>{t('DURATION')}</th>
      <th>{t('ACTIONS')}</th>
     </tr></thead>
     <tbody>{visible.map(task=>{const expanded=task.id===selectedId;const toggle=()=>setSelectedId(current=>current===task.id?'':task.id);return <Fragment key={task.id}><tr className={'task-row'+(expanded?' selected':'')} onClick={toggle}>
      <td>
       <button className="project-link task-link" aria-label={t('Open task details')} onClick={event=>{event.stopPropagation();setSelectedId(task.id);}}>
        {t(KIND_LABELS[task.kind])}
       </button>
       <small className="task-id">{task.id.slice(0,8)}</small>
      </td>
      <td className="task-status-cell">
       <span className={'badge '+task.state}>{t(STATE_LABELS[task.state])}</span>
       {task.cancelRequested&&task.state==='running'&&<small>{t('Cancel requested')}</small>}
      </td>
      <td>{task.progress?<span className="task-progress" title={task.progress}>{task.progress}</span>:<span className="muted">—</span>}</td>
      <td><RelatedChips task={task}/></td>
      <td>{task.attempts} / {task.maxAttempts}</td>
      <td><span className="task-created">{formatDateTime(task.createdAt,dateTag)}</span></td>
      <td>{formatDuration(taskDuration(task,now))}</td>
      <td>
       <div className="task-actions">
        <button className="secondary" aria-expanded={expanded} onClick={event=>{event.stopPropagation();toggle();}}>{expanded?t('Hide details'):t('View details')}</button>
        {canWrite&&(task.state==='queued'||task.state==='running')&&<button className="secondary" disabled={busyId!==''} onClick={event=>{event.stopPropagation();void act(task,'cancel');}}><Ban size={13}/>{t('Cancel')}</button>}
        {canWrite&&(task.state==='failed'||task.state==='cancelled')&&<button className="secondary" disabled={busyId!==''} onClick={event=>{event.stopPropagation();void act(task,'retry');}}><RotateCcw size={13}/>{t('Retry')}</button>}
       </div>
      </td>
     </tr>
     {expanded&&<tr className="task-detail-row"><td colSpan={8}>
      <TaskDetail task={task} canWrite={canWrite} busy={busyId!==''} now={now}
       onCancel={task=>void act(task,'cancel')} onRetry={task=>void act(task,'retry')} onClose={()=>setSelectedId('')}/>
     </td></tr>}
    </Fragment>;})}</tbody>
    </table>
   </div>}
  </section>
 </div>;
}

function RelatedChips({task}:{task:Task}){
 const {t}=useI18n();
 const entries:{key:string;label:string;value:string}[]=[];
 if(task.projectId)entries.push({key:'project',label:t('Project'),value:task.projectId});
 if(task.eventId)entries.push({key:'event',label:t('Event'),value:task.eventId});
 if(task.sourceId)entries.push({key:'source',label:t('Source'),value:task.sourceId});
 if(!entries.length)return <span className="muted">—</span>;
 return <div className="chips task-related">{entries.map(entry=><span key={entry.key} title={entry.value}>{entry.label}: {entry.value.slice(0,8)}</span>)}</div>;
}

function TaskDetail({task,canWrite,busy,now,onCancel,onRetry,onClose}:{
 task:Task;
 canWrite:boolean;
 busy:boolean;
 now:number;
 onCancel:(task:Task)=>void;
 onRetry:(task:Task)=>void;
 onClose:()=>void;
}){
 const {t,lang}=useI18n();
 const dateTag=locale(lang);
 const payload=jsonText(task.payload);
 const result=jsonText(task.result);
 const canCancel=task.state==='queued'||task.state==='running';
 const canRetry=task.state==='failed'||task.state==='cancelled';
 const related:[string,string][]=[];
 if(task.projectId)related.push([t('Project'),task.projectId]);
 if(task.eventId)related.push([t('Event'),task.eventId]);
 if(task.sourceId)related.push([t('Source'),task.sourceId]);
 return <section className="panel task-detail" aria-label={t('Task details')}>
  <div className="panel-heading">
   <div>
    <h2>{t('Task details')} <span className="count">{task.id.slice(0,8)}</span></h2>
    <p>{t(KIND_LABELS[task.kind])} · {formatDateTime(task.createdAt,dateTag)}</p>
   </div>
   <div className="heading-actions">
    {canWrite&&canCancel&&<button className="secondary" disabled={busy} onClick={()=>onCancel(task)}><Ban size={15}/>{t('Cancel task')}</button>}
    {canWrite&&canRetry&&<button className="secondary" disabled={busy} onClick={()=>onRetry(task)}><RotateCcw size={15}/>{t('Retry task')}</button>}
    <button className="icon-button" aria-label={t('Close details')} onClick={onClose}><X size={18}/></button>
   </div>
  </div>
  {task.cancelRequested&&task.state==='running'&&<div className="task-detail-body"><p className="small">{t('Cancellation requested; the runner will stop after the current step.')}</p></div>}
  <div className="task-detail-meta">
   <div><span className="eyebrow">{t('Status')}</span><span className={'badge '+task.state}>{t(STATE_LABELS[task.state])}</span></div>
   <div><span className="eyebrow">{t('Progress')}</span><strong>{task.progress||'—'}</strong></div>
   <div><span className="eyebrow">{t('Attempts')}</span><strong>{task.attempts} / {task.maxAttempts}</strong></div>
   <div><span className="eyebrow">{t('Priority')}</span><strong>{'P'+task.priority}</strong></div>
   <div><span className="eyebrow">{t('Effective priority')}</span><strong>{'P'+task.effectivePriority}</strong></div>
   <div><span className="eyebrow">{t('Duration')}</span><strong>{formatDuration(taskDuration(task,now))}</strong></div>
   <div><span className="eyebrow">{t('Created')}</span><strong>{formatDateTime(task.createdAt,dateTag)}</strong></div>
   <div><span className="eyebrow">{t('Updated')}</span><strong>{formatDateTime(task.updatedAt,dateTag)}</strong></div>
   <div><span className="eyebrow">{t('Started')}</span><strong>{formatDateTime(task.startedAt,dateTag)}</strong></div>
   <div><span className="eyebrow">{t('Finished')}</span><strong>{formatDateTime(task.finishedAt,dateTag)}</strong></div>
   <div><span className="eyebrow">{t('Next attempt')}</span><strong>{task.state==='queued'?formatDateTime(task.notBefore,dateTag):'—'}</strong></div>
   <div><span className="eyebrow">{t('Task ID')}</span><strong className="task-id-full">{task.id}</strong></div>
   <div className="task-related-cell"><span className="eyebrow">{t('Related')}</span>
    {related.length?<div className="chips">{related.map(([label,value])=><span key={label} title={value}>{label}: {value}</span>)}</div>:<strong>—</strong>}
   </div>
  </div>
  {task.error&&<div className="task-detail-body"><div role="alert" className="alert error"><AlertCircle size={17}/>{task.error}</div></div>}
  <div className="task-detail-body">
   <div className="task-json">
    <div className="eyebrow">{t('Payload')}</div>
    {payload?<pre>{payload}</pre>:<p className="muted">{t('No payload recorded.')}</p>}
   </div>
   <div className="task-json">
    <div className="eyebrow">{t('Result')}</div>
    {result&&task.result!==null&&task.result!==undefined?<pre>{result}</pre>:<p className="muted">{t('No result recorded.')}</p>}
   </div>
   <div className="task-json">
    <div className="eyebrow">{t('Log timeline')} <span className="count">{task.log.length}</span></div>
    {task.log.length?<ol className="task-log">{task.log.map((entry,index)=><li key={entry.at+':'+index} className={entry.level}>
     <span className="log-time">{formatDateTime(parseTime(entry.at),dateTag)}</span>
     <span className="log-level">{t(entry.level==='warn'?'Warning':entry.level==='error'?'Error':'Info')}</span>
     <span className="log-message">{entry.message}</span>
    </li>)}</ol>:<p className="muted">{t('No log entries recorded yet.')}</p>}
   </div>
  </div>
 </section>;
}

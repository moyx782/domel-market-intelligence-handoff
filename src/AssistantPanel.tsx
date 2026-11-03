import {useRef,useState} from 'react';
import {Bot,LoaderCircle,Send,Square} from 'lucide-react';
import {backendBase,supabase,usesLocalBackend} from './data';
import {useI18n} from './i18n';

type Turn={role:'user'|'assistant';text:string};

// Read-only Q&A over one project's stored evidence. The host API streams
// Server-Sent Events; this component only renders them and never writes data.
export default function AssistantPanel({projectId}:{projectId:string}){
 const {t}=useI18n();
 const [turns,setTurns]=useState<Turn[]>([]);
 const [draft,setDraft]=useState('');
 const [status,setStatus]=useState('');
 const [error,setError]=useState('');
 const [streaming,setStreaming]=useState(false);
 const abort=useRef<AbortController|null>(null);

 async function send(event:React.FormEvent){
  event.preventDefault();
  const message=draft.trim();
  if(!message||streaming)return;
  setDraft('');setError('');setStatus('');setStreaming(true);
  setTurns(current=>[...current,{role:'user',text:message},{role:'assistant',text:''}]);
  const controller=new AbortController();abort.current=controller;
  try{
   const headers:{[key:string]:string}={'Content-Type':'application/json'};
   if(!usesLocalBackend){
    const {data}=await supabase!.auth.getSession();
    if(!data.session)throw Error(t('Please sign in again.'));
    headers.Authorization='Bearer '+data.session.access_token;
   }
   const response=await fetch(backendBase+'/api/v1/research-tasks/'+projectId+'/assistant',{
    method:'POST',signal:controller.signal,headers,
    body:JSON.stringify({message}),
   });
   if(!response.ok){const payload=await response.json().catch(()=>({}));throw Error(t(payload.error||'Assistant request failed'));}
   if(!response.body)throw Error(t('This browser cannot stream the assistant response.'));
   const reader=response.body.getReader(),decoder=new TextDecoder();
   let buffer='';
   for(;;){
    const {value,done}=await reader.read();
    if(done)break;
    buffer+=decoder.decode(value,{stream:true});
    let split;
    while((split=buffer.indexOf('\n\n'))>=0){
     const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);
     const line=frame.split('\n').find(part=>part.startsWith('data: '));
     if(!line)continue;
     let event:{type:string;text?:string;tool?:string;error?:string};
     try{event=JSON.parse(line.slice(6));}catch{continue;}
     if(event.type==='delta')setTurns(current=>current.map((turn,index)=>index===current.length-1?{...turn,text:turn.text+(event.text??'')}:turn));
     else if(event.type==='tool_start'||event.type==='tool_end')setStatus(event.type==='tool_start'?'Reading project data…':'');
     else if(event.type==='error')setError(t(event.error||'Assistant run failed'));
    }
   }
  }catch(cause){
   if((cause as Error).name!=='AbortError')setError(cause instanceof Error?cause.message:String(cause));
  }finally{
   abort.current=null;setStreaming(false);setStatus('');
  }
 }

 return <section className="panel padded assistant">
  <div className="panel-heading"><div><h2><Bot size={18}/> {t('Ask about this project')}</h2><p>{t('Read-only answers from saved sources and review decisions. This chat cannot run research or change evidence.')}</p></div>{streaming&&<span className="assistant-status"><LoaderCircle className="spin" size={15}/>{status||t('Thinking…')}</span>}</div>
  {error&&<div role="alert" className="alert error">{error}</div>}
  <div className="assistant-log" aria-live="polite">
   {turns.length===0?<p className="muted">{t('For example: “Which competitors have accepted findings, and what is still missing?”')}</p>:turns.map((turn,index)=><div key={index} className={'assistant-turn '+turn.role}><span className="eyebrow">{turn.role==='user'?t('YOU'):t('ASSISTANT')}</span><p>{turn.text||(turn.role==='assistant'&&streaming?'…':'')}</p></div>)}
  </div>
  <form className="assistant-form" onSubmit={send}>
   <input aria-label={t('Ask the research assistant')} placeholder={t('Ask about this project…')} value={draft} maxLength={8000} onChange={e=>setDraft(e.target.value)} disabled={streaming}/>
   {streaming?<button type="button" className="secondary" onClick={()=>abort.current?.abort()}><Square size={15}/> {t('Stop')}</button>:<button type="submit" className="primary" disabled={!draft.trim()}><Send size={15}/> {t('Send')}</button>}
  </form>
 </section>;
}

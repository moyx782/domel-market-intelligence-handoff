import {useState} from 'react';
import {ArrowRight,ShieldCheck} from 'lucide-react';
import {useI18n} from './i18n';
import {agentBriefProject} from './agent-brief.mjs';
import type {Project} from './types';
import './messages-research';
type Input=Pick<Project,'title'|'question'|'segment'|'market'|'quarter'|'competitors'|'focus'|'source_urls'>;
export default function NewAgentResearch({busy,onSubmit}:{busy:boolean;onSubmit:(p:Input)=>void}){
 const {t}=useI18n();const [direction,setDirection]=useState(''),[question,setQuestion]=useState(''),[error,setError]=useState('');
 return <><div className="page-heading"><div><h1>{t('New research')}</h1><p>{t('Tell the Agent your research direction and questions.')}</p></div></div><div className="new-grid"><form className="panel research-form" onSubmit={e=>{e.preventDefault();try{const p=agentBriefProject(direction,question);setError('');onSubmit(p);}catch{setError(t('Enter a valid research direction and question.'));}}}>
 <label>{t('Research direction')}<textarea required maxLength={120} rows={2} value={direction} onChange={e=>setDirection(e.target.value)}/></label>
 <label>{t('Research questions and requirements')}<textarea required maxLength={1500} rows={8} value={question} onChange={e=>setQuestion(e.target.value)}/></label>
 <p>{t('Include companies, region, dates or preferred sources in your question when needed.')}</p>
 {error&&<p role="alert">{error}</p>}<div className="form-bottom"><span><ShieldCheck size={15}/>{t('Public information only')}</span><button className="primary" disabled={busy}>{busy?t('Sending to Agent…'):t('Send research to Agent')}<ArrowRight size={16}/></button></div></form>
 <aside className="research-aside"><section className="panel padded"><h2>{t('Research, review, report')}</h2><p>{t('The Agent collects public evidence. Review source passages, edit and approve findings, then generate a report from approved findings only.')}</p><p>{t('If Agent startup fails, your project stays saved. Retry Agent research from project progress.')}</p></section></aside></div></>;
}

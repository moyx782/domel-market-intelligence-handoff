import {useState} from 'react';
import {Download,ExternalLink,BookOpen} from 'lucide-react';
import type {Project,Source} from './types';
import './source-library.css';

export default function SourceLibrary({project,sources}:{project:Project;sources:Source[]}) {
 const [query,setQuery]=useState(''),[unknownOnly,setUnknownOnly]=useState(false),[showExport,setShowExport]=useState(false);
 const q=query.trim().toLowerCase();
 const visible=sources.filter(s=>(!unknownOnly||!s.published_at)&&(!q||(s.title+' '+s.url+' '+s.text).toLowerCase().includes(q)));
 const payload={kind:'unreviewed-source-evidence',scope:{title:project.title,question:project.question,segment:project.segment,market:project.market,quarter:project.quarter,competitors:project.competitors,focus:project.focus},sources,coverage_notices:project.errors,limitations:['Source collection is not AI extraction or evidence approval.','Text is a stored excerpt, up to 24,000 characters, not an archived full webpage.','Market and quarter relevance must be verified by a reviewer.']};
 const exportJson=JSON.stringify(payload,null,2);
 function downloadEvidence(){
  const url=URL.createObjectURL(new Blob([exportJson],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='domel-sources-'+project.id+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="panel padded source-library" aria-label="Collected source evidence">
  <div className="source-library-heading"><div><div className="eyebrow">TRACEABLE PUBLIC INFORMATION</div><h2><BookOpen size={19}/> Collected sources <span className="count">{sources.length}</span></h2></div><button className="secondary" disabled={!sources.length} onClick={()=>setShowExport(!showExport)} aria-expanded={showExport}><Download size={16}/> Export source evidence</button></div>
  {showExport&&<div className="source-export"><h3>Source evidence JSON</h3><p className="small">Inspect or select and copy this JSON. You can also download it as a file.</p><button className="secondary" onClick={downloadEvidence}>Download JSON</button><pre aria-label="Source evidence JSON">{exportJson}</pre></div>}
  <p className="small">These are collected source excerpts, not approved findings. Check relevance to {project.market} and {project.quarter} before drawing conclusions. AI extraction requires an API.</p>
  <div className="source-library-tools"><label className="source-search">Search saved text<input type="search" placeholder="Title, URL or words in the source…" value={query} onChange={e=>setQuery(e.target.value)}/></label><label className="source-date-filter"><input type="checkbox" checked={unknownOnly} onChange={e=>setUnknownOnly(e.target.checked)}/> Unknown publication dates only</label></div>
  {!visible.length&&<p className="muted">{sources.length?'No sources match your filters.':'No sources saved yet. Enter public source URLs when creating a project, then collect them.'}</p>}
  {visible.map(s=><article className="collected-source" key={s.id}><h3>{s.title}</h3><a className="source-link" href={s.url} target="_blank" rel="noreferrer">{s.url}<ExternalLink size={14}/></a><div className="source-meta">Published: {s.published_at?new Date(s.published_at).toLocaleString():'Unknown — verify quarter relevance'}<br/>Retrieved: {new Date(s.retrieved_at).toLocaleString()} · {s.text.length.toLocaleString()} stored characters</div><p className="small">{s.text.slice(0,260)}{s.text.length>260?'…':''}</p><details><summary>Read stored source excerpt</summary><pre>{s.text}</pre></details></article>)}
 </section>;
}

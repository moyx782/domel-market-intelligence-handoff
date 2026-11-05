import {useEffect,useState} from 'react';
import {backendBase} from './data';
import type {Role} from './types';
import './messages-exhibition';
type RecordRow=Record<string,any>;
async function api(path:string,body?:unknown){const r=await fetch(backendBase+'/api/v1/exhibition-studies'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
export default function ExhibitionStudy({role,onProject}:{role:Role;onProject:(id:string)=>void}){
 const [list,setList]=useState<RecordRow[]>([]),[study,setStudy]=useState<RecordRow|null>(null),[id,setId]=useState('');
 const [name,setName]=useState(''),[edition,setEdition]=useState(''),[urls,setUrls]=useState(''),[addUrl,setAddUrl]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[accept,setAccept]=useState(false),[filter,setFilter]=useState(''),[kind,setKind]=useState('all'),[artifact,setArtifact]=useState<RecordRow|null>(null);
 const write=role!=='viewer';
 const refresh=async()=>{const d=await api('');setList(d.studies);if(id)setStudy(await api('/'+id));};
 useEffect(()=>{let active=true;const read=()=>api('').then(async d=>{if(!active)return;setList(d.studies);if(id){const s=await api('/'+id);if(active)setStudy(s);}}).catch(e=>{if(active)setError(e.message);});void read();const timer=setInterval(read,5000);return()=>{active=false;clearInterval(timer);};},[id]);
 async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 const settled=study&&study.coverage.pending===0;
 const allCompanies:RecordRow[]=study?.companies||[];
 const companies=allCompanies.filter(c=>!settled||(kind==='all'||c.relationship===kind)&&JSON.stringify(c).toLowerCase().includes(filter.toLowerCase()));
 function download(){if(!study)return;const u=URL.createObjectURL(new Blob([JSON.stringify(study,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='exhibition-'+study.id+'.json';a.click();URL.revokeObjectURL(u);}
 return <><div className="page-heading"><div><h1>展会全量研究 / Exhibition capture</h1><p>展会 → 全部参展企业 → 企业产品 → 参数与价格 → 采集后筛选。包含潜在下游电器客户，采集时不按相关性排除企业。</p></div></div>
 {error&&<p role="alert" className="alert error">{error}</p>}
 <section className="panel padded"><h2>建立采集范围 / Start a public-source study</h2><p>先填写具体届次与公开入口：展会首页、展商目录、分类页或公开文件 URL。系统遍历发现的目录分页和产品链接；无法获取、动态未展开及总量未知均显示缺口，不宣称抓取全网。</p>
 <form onSubmit={e=>{e.preventDefault();void action(async()=>{const s=await api('',{name,edition,urls:urls.split('\n').map(s=>s.trim()).filter(Boolean)});setId(s.id);setStudy(s);setAccept(false);setFilter('');setKind('all');});}}>
 <label>展会名称 / Exhibition<input required maxLength={150} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label>届次 / Edition<input required maxLength={40} value={edition} onChange={e=>setEdition(e.target.value)} placeholder="2027 / 第38届"/></label>
 <label>公开入口网址 / Entry URLs<textarea required rows={3} value={urls} onChange={e=>setUrls(e.target.value)} placeholder="https://...（每行一个）"/></label>
 <button className="primary" disabled={busy||!write}>开始采集全部公开条目 / Collect first</button></form></section>
 <section className="panel padded"><label>已保存的研究 / Saved studies<select value={id} onChange={e=>{setId(e.target.value);setAccept(false);setFilter('');setKind('all');setArtifact(null);}}><option value="">选择研究</option>{list.map(s=><option key={s.id} value={s.id}>{s.name} · {s.edition}</option>)}</select></label></section>
 {study&&<><section className="panel padded"><h2>{study.name} · {study.edition}</h2><p role="status">{study.coverage.status} | 已发现页面 {study.coverage.discoveredPages} | 已采集 {study.coverage.captured} | 待处理 {study.coverage.pending} | 失败 {study.coverage.failed} | 企业 {allCompanies.length} | 产品 {study.products.length}</p>
 <p>官网声明展商总量：{study.knownExhibitorTotal??'未知 / unverified'}；已知数量缺口：{study.coverage.missingCompanies??'无法确认'}。遍历完已发现链接不等于已获取所有企业或产品。</p>
 <label>补充目录或文件 URL / Add another public entry<input value={addUrl} onChange={e=>setAddUrl(e.target.value)}/></label>
 <button disabled={busy||!write} onClick={()=>void action(async()=>{await api('/'+id+'/resume',addUrl?{url:addUrl,stage:'directory'}:{});setAddUrl('');await refresh();})}>补充入口 / 重试失败任务</button>
 <button disabled={busy||!write} onClick={()=>void action(async()=>{await api('/'+id+'/cancel',{});await refresh();})}>暂停本研究的全部采集任务</button>
 <button onClick={download}>导出全部原始研究 JSON</button>
 <label><input type="checkbox" checked={accept} onChange={e=>setAccept(e.target.checked)}/>我已查看缺口，允许对当前不完整快照进行分析或提交审核。</label>
 <button disabled={busy||!write||!settled} onClick={()=>void action(async()=>{await api('/'+id+'/analyse',{acceptPartial:accept});await refresh();})}>采集结束后分析客户／竞品关系</button>
 <button disabled={busy||!write||!settled} onClick={()=>void action(async()=>{const r=await api('/'+id+'/publish',{acceptPartial:accept});onProject(r.projectId);})}>提交事实到现有审核与报告流程</button>
 {!settled&&<p>仍有采集任务，筛选与提交审核暂不可用。可在“任务”页取消或检查日志。</p>}
 <details><summary>缺口与失败 / Gaps ({study.gaps.length})</summary>{study.gaps.map((g:RecordRow,i:number)=><p key={i}><a href={g.url} target="_blank" rel="noreferrer">来源</a>：{g.message}</p>)}</details>
 <details><summary>所有采集页面及状态</summary>{study.pages.map((p:RecordRow)=><p key={p.id}>{p.stage} · {p.state} · <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a> {p.error}</p>)}</details></section>
 <section className="panel padded"><h2>候选参展企业（保留全部原始条目）</h2><input aria-label="采集后筛选企业" disabled={!settled} value={filter} onChange={e=>setFilter(e.target.value)} placeholder="采集结束后筛选 / Filter after collection"/>
 <select aria-label="企业关系分类" disabled={!settled} value={kind} onChange={e=>setKind(e.target.value)}><option value="all">全部</option><option value="potential_customer">潜在下游客户</option><option value="competitor">竞品</option><option value="partner_candidate">潜在合作</option><option value="unclassified">未分类</option></select>
 <p>关系标签是待人工审核的推断，应用匹配不证明已使用或采购 Domel 产品。重新采集后需重新分析。</p>
 {companies.map(c=><article className="log-row" key={c.id}><div><h3>{c.name}</h3><p>{c.relationship} {c.analysis?.reason} {c.analysis&&c.analysis.snapshotEvidenceCount!==study.evidence.length?'（分析已过期）':''}</p>{c.profileUrl&&<a href={c.profileUrl} target="_blank" rel="noreferrer">企业页面</a>}
 <p>来源届次：{[...new Set(c.evidence.map((ref:RecordRow)=>ref.edition||'unknown'))].join(', ')}。未知或往届资料不证明本届参展。</p><p>来源：{c.evidence.map((ref:RecordRow,i:number)=>{const e=study.evidence.find((e:RecordRow)=>e.id===ref.evidenceId);return e?<a key={i} href={e.url} target="_blank" rel="noreferrer"> [{e.title}] </a>:null;})}</p>
 {study.products.filter((p:RecordRow)=>p.companyId===c.id).map((p:RecordRow)=><div key={p.id}><strong>{p.name} {p.model}</strong><p>产品归属于该企业；未自动认定为本届展出产品。</p>{study.facts.filter((f:RecordRow)=>f.subjectId===p.id).map((f:RecordRow)=><p key={f.id}>{f.field}: {f.value} {f.unit} {f.conditions} {f.currency} {f.priceBasis} · <a href={f.sourceUrl} target="_blank" rel="noreferrer">原始网址</a></p>)}</div>)}</div></article>)}</section>
 <section className="panel padded"><h2>全部事实、参数与价格（未自动批准）</h2>{study.facts.map((f:RecordRow)=><details key={f.id}><summary>{f.field}: {f.value} {f.unit}</summary><p>条件：{f.conditions||'未提供'}；币种：{f.currency||'未提供'}；价格条件：{f.priceBasis||'未提供'}；来源届次：{f.sourceEdition||'未知'}</p><blockquote>{f.quote}</blockquote><a href={f.sourceUrl} target="_blank" rel="noreferrer">{f.sourceUrl}</a><p>定位：{f.locator}</p></details>)}</section>
 <section className="panel padded"><h2>证据快照 / Evidence archive</h2>{study.evidence.map((e:RecordRow)=><div className="log-row" key={e.id}><div><a href={e.url} target="_blank" rel="noreferrer">{e.title}</a><p>{e.capturedAt} · {e.method} · SHA256 {e.sha256}</p><button onClick={()=>void action(async()=>setArtifact(await api('/'+id+'/evidence/'+e.id)))}>查看原文、HTML、文件或截图</button></div></div>)}</section>
 {artifact&&<section className="panel padded"><h2>已保存证据</h2><a href={artifact.finalUrl} target="_blank" rel="noreferrer">原始页面</a><p>{artifact.capturedAt} · {artifact.method}</p>{artifact.binary&&<><a download={artifact.binary.filename} href={'data:'+artifact.binary.mime+';base64,'+artifact.binary.base64}>下载原文件／截图</a>{artifact.binary.mime==='image/png'&&<img style={{maxWidth:'100%'}} alt="Captured source screenshot" src={'data:image/png;base64,'+artifact.binary.base64}/>}</>}<pre style={{whiteSpace:'pre-wrap',maxHeight:500,overflow:'auto'}}>{artifact.text}</pre><details><summary>原始 HTML（只读文本）</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:400,overflow:'auto'}}>{artifact.html}</pre></details></section>}
 </>}</>;
}

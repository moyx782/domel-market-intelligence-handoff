import {useEffect,useState} from 'react';
import {hostJobs} from './data';
type Job={id:string;project_id:string;environment:string;mode:string;state:string;priority:number;attempt:number;updated_at:string};
export default function HostQueue({projectId}:{projectId:string}){
 const [jobs,setJobs]=useState<Job[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;const read=()=>hostJobs().then(rows=>{if(active){setJobs(rows.filter((j:Job)=>j.project_id===projectId));setError('');}}).catch(e=>{if(active)setError(e.message);});read();const timer=setInterval(read,5000);return()=>{active=false;clearInterval(timer);};},[projectId]);
 return <section className="panel padded"><h2>Host execution queue</h2><p className="small">Execution runs on the team host. Jobs and results persist in cloud Supabase. A succeeded job means execution finished; check project findings and coverage notices to confirm whether insights were generated.</p>{error&&<p role="status">{error}</p>}{!error&&!jobs.length&&<p>No host jobs submitted for this project.</p>}{jobs.map(j=><div className="log-row" key={j.id}><div><strong>{j.state} �� {j.mode}</strong><p className="small">Environment: {j.environment} �� P{j.priority} �� Attempt {j.attempt} �� Updated {new Date(j.updated_at).toLocaleString()}</p></div></div>)}</section>;
}

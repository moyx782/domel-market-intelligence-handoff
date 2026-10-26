-- Additive migration: existing evidence IDs, auth and reports remain intact.
create table public.research_jobs (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 environment text not null check(environment ~ '^[a-zA-Z0-9_-]{1,40}$'),
 mode text not null check(mode in ('collect','research','extract')),
 state text not null default 'queued' check(state in ('queued','running','succeeded','failed')),
 priority integer not null default 1 check(priority between 0 and 3),
 attempt integer not null default 0, lease_token uuid, lease_until timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index one_active_research_job on public.research_jobs(project_id) where state in ('queued','running');
alter table public.research_jobs enable row level security;
revoke all on public.research_jobs from public,anon,authenticated;
grant select on public.research_jobs to authenticated;
grant all on public.research_jobs to service_role;
create policy own_jobs on public.research_jobs for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=(select auth.uid())));

create function public.enqueue_research(p_project uuid,p_mode text,p_environment text)
returns public.research_jobs language plpgsql security definer set search_path='' as $$
declare p public.projects; j public.research_jobs;
begin
 select * into p from public.projects where id=p_project and owner_id=auth.uid() for update;
 if not found then raise exception 'Project not accessible'; end if;
 if p_mode not in ('collect','research','extract') or p_mode is null then raise exception 'Invalid mode';end if;
 select * into j from public.research_jobs where project_id=p.id and state in ('queued','running');
 if found then
  if j.environment<>p_environment or j.mode<>p_mode then raise exception 'Project already queued in another environment or mode';end if;
  return j;
 end if;
 if p_mode='extract' then
  if p.status not in ('partial','failed','completed') or not exists(select 1 from public.sources where project_id=p.id) or exists(select 1 from public.findings where project_id=p.id) then raise exception 'Saved extraction is unavailable';end if;
 elsif p.status<>'draft' then raise exception 'Create a new project for a new research run';end if;
 insert into public.research_jobs(project_id,mode,environment) values(p.id,p_mode,p_environment) returning * into j;
 update public.projects set status='running',stage='Queued on team host',updated_at=now() where id=p.id;
 return j;
end $$;
revoke all on function public.enqueue_research(uuid,text,text) from public,anon;
grant execute on function public.enqueue_research(uuid,text,text) to authenticated;

create function public.claim_research(p_environment text)
returns setof public.research_jobs language plpgsql security definer set search_path='' as $$
declare j public.research_jobs;
begin
 -- Expired final attempts become visible failures, rather than permanently running.
 for j in select * from public.research_jobs where environment=p_environment and state='running' and lease_until<now() and attempt>=3 for update skip locked loop
  update public.research_jobs set state='failed',updated_at=now() where id=j.id;
  update public.projects set status='failed',stage='Host execution interrupted',errors=array['Worker lease expired after three attempts.'],updated_at=now() where id=j.project_id;
 end loop;
 select * into j from public.research_jobs where environment=p_environment and (state='queued' or (state='running' and lease_until<now() and attempt<3))
 order by greatest(0,priority-floor(extract(epoch from(now()-created_at))/300)),created_at,id for update skip locked limit 1;
 if not found then return;end if;
 update public.research_jobs set state='running',attempt=attempt+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',updated_at=now() where id=j.id returning * into j;
 update public.projects set stage='Running on team host',updated_at=now() where id=j.project_id;
 return next j;
end $$;
create function public.heartbeat_research(p_job uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.research_jobs set lease_until=now()+interval '180 seconds',updated_at=now() where id=p_job and lease_token=p_token and state='running' and lease_until>now();
 return found;
end $$;

create function public.finish_research(p_job uuid,p_token uuid,p_result jsonb,p_sources jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.research_jobs; s jsonb; f jsonb; sid uuid;
begin
 select * into j from public.research_jobs where id=p_job for update;
 if not found or j.lease_token is distinct from p_token then raise exception 'Worker lease lost';end if;
 if j.state in ('succeeded','failed') then return true;end if;
 if j.state<>'running' or j.lease_until<=now() then raise exception 'Worker lease lost';end if;
 -- All source/finding writes and job completion commit together. Retry is idempotent.
 for s in select value from jsonb_array_elements(p_sources) loop
  sid:=(s->>'id')::uuid;
  if j.mode='extract' then
   if not exists(select 1 from public.sources where id=sid and project_id=j.project_id) then raise exception 'Saved source not accessible';end if;
  else
   insert into public.sources(id,project_id,url,title,text,published_at,retrieved_at,competitor)
   values(sid,j.project_id,s->>'url',s->>'title',s->>'text',nullif(s->>'published_at','')::timestamptz,(s->>'retrieved_at')::timestamptz,'Source-level evidence');
  end if;
  for f in select value from jsonb_array_elements(coalesce(s->'findings','[]')) loop
   if not exists(select 1 from public.sources src join public.projects p on p.id=src.project_id where src.id=sid and src.project_id=j.project_id and position(f->>'quote' in src.text)>0 and length(f->>'quote') between 30 and 1200 and f->>'competitor'=any(p.competitors) and f->>'field'=any(p.focus)) then raise exception 'Invalid finding evidence';end if;
   insert into public.findings(project_id,source_id,competitor,field,original_text,edited_text,quote)
   values(j.project_id,sid,f->>'competitor',f->>'field',f->>'text',f->>'text',f->>'quote');
  end loop;
 end loop;
 update public.projects set status=p_result->>'status',stage=p_result->>'stage',errors=array(select jsonb_array_elements_text(p_result->'errors')),updated_at=now() where id=j.project_id;
 update public.research_jobs set state=case when p_result->>'status'='failed' then 'failed' else 'succeeded' end,updated_at=now() where id=j.id;
 return true;
end $$;
revoke all on function public.claim_research(text),public.heartbeat_research(uuid,uuid),public.finish_research(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_research(text),public.heartbeat_research(uuid,uuid),public.finish_research(uuid,uuid,jsonb,jsonb) to service_role;

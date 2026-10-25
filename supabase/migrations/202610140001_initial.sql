-- Run on a new Supabase project. No secrets belong in this file.
create table public.projects (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 title text not null check(length(trim(title)) between 1 and 150), question text not null check(length(trim(question)) between 1 and 2000),
 segment text not null check(length(trim(segment)) between 1 and 120), market text not null check(length(trim(market)) between 1 and 120),
 quarter text not null check(quarter ~ '^20[0-9]{2}-Q[1-4]$'),
 competitors text[] not null check(cardinality(competitors) between 1 and 3),
 focus text[] not null check(cardinality(focus) between 1 and 5), source_urls text[] not null default '{}' check(cardinality(source_urls)<=15),
 status text not null default 'draft' check(status in ('draft','running','completed','partial','failed')),
 stage text not null default 'Not started', errors text[] not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.sources (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 url text not null check(url like 'https://%'), title text not null, published_at timestamptz,
 retrieved_at timestamptz not null default now(), text text not null, competitor text not null,
 unique(id,project_id)
);
create table public.findings (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 source_id uuid not null, competitor text not null, field text not null,
 original_text text not null, edited_text text not null check(length(trim(edited_text)) between 1 and 4000),
 quote text not null, decision text not null default 'pending' check(decision in ('pending','accepted','rejected')),
 revision integer not null default 1, reviewer_id uuid references auth.users(id), reviewed_at timestamptz,
 foreign key(source_id,project_id) references public.sources(id,project_id)
);
create table public.review_events (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 finding_id uuid not null references public.findings(id), actor_id uuid not null references auth.users(id),
 action text not null, old_text text not null, new_text text not null,
 decision text not null check(decision in ('pending','accepted','rejected')), revision integer not null,
 created_at timestamptz not null default now()
);
create table public.reports (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 version integer not null, created_at timestamptz not null default now(), snapshot jsonb not null,
 unique(project_id,version)
);
create index on public.projects(owner_id);
create index on public.sources(project_id);
create index on public.findings(project_id,decision);
create index on public.review_events(project_id,finding_id);
create index on public.reports(project_id);
alter table public.projects enable row level security;
alter table public.sources enable row level security;
alter table public.findings enable row level security;
alter table public.review_events enable row level security;
alter table public.reports enable row level security;
create policy own_projects on public.projects for select to authenticated using(owner_id=(select auth.uid()));
create policy create_projects on public.projects for insert to authenticated with check(owner_id=(select auth.uid()) and status='draft' and stage='Not started' and cardinality(errors)=0);
create policy own_sources on public.sources for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=(select auth.uid())));
create policy own_findings on public.findings for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=(select auth.uid())));
create policy own_reviews on public.review_events for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=(select auth.uid())));
create policy own_reports on public.reports for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=(select auth.uid())));
revoke all on public.projects,public.sources,public.findings,public.review_events,public.reports from anon,authenticated;
grant select,insert on public.projects to authenticated;
grant select on public.sources,public.findings,public.review_events,public.reports to authenticated;
grant all on public.projects,public.sources,public.findings,public.review_events,public.reports to service_role;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
create function private.review_finding(p_id uuid,p_text text,p_decision text,p_revision integer)
returns public.findings language plpgsql security definer set search_path = '' as $$
declare f public.findings; old_text text; changed boolean;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_decision not in ('pending','accepted','rejected') or p_decision is null then raise exception 'Invalid decision'; end if;
 if p_text is null or length(trim(p_text)) not between 1 and 4000 then raise exception 'Invalid finding wording'; end if;
 select * into f from public.findings where id=p_id for update;
 if not found or not exists(select 1 from public.projects where id=f.project_id and owner_id=auth.uid()) then raise exception 'Finding not accessible'; end if;
 if f.revision <> p_revision or p_revision is null then raise exception 'This finding changed. Refresh and try again.'; end if;
 old_text:=f.edited_text; changed:=trim(p_text)<>old_text;
 update public.findings set edited_text=trim(p_text),decision=case when changed then 'pending' else p_decision end,
 revision=revision+1,reviewer_id=case when changed or p_decision='pending' then null else auth.uid() end,
 reviewed_at=case when changed or p_decision='pending' then null else now() end where id=p_id returning * into f;
 insert into public.review_events(project_id,finding_id,actor_id,action,old_text,new_text,decision,revision)
 values(f.project_id,f.id,auth.uid(),case when changed then 'edit' else p_decision end,old_text,f.edited_text,f.decision,f.revision);
 return f;
end $$;
create function private.generate_report(p_project uuid)
returns public.reports language plpgsql security definer set search_path = '' as $$
declare p public.projects; r public.reports; approved jsonb; refs jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select * into p from public.projects where id=p_project and owner_id=auth.uid() for update;
 if not found then raise exception 'Project not accessible'; end if;
 -- A single SQL statement gives findings and sources the same MVCC snapshot.
 with approved_rows as (select * from public.findings where project_id=p_project and decision='accepted'),
 ref_rows as (select * from public.sources where id in(select source_id from approved_rows))
 select (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from approved_rows a),
 (select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from ref_rows s) into approved,refs;
 if jsonb_array_length(approved)=0 then raise exception 'Accept at least one finding before generating a report.'; end if;
 insert into public.reports(project_id,version,snapshot)
 values(p_project,(select coalesce(max(version),0)+1 from public.reports where project_id=p_project),
 jsonb_build_object('project',to_jsonb(p),'findings',approved,'sources',refs,'limitations',
 jsonb_build_array('Only human-approved findings are included. Missing information means insufficient evidence, not absence of competitor activity.')||to_jsonb(p.errors))) returning * into r;
 return r;
end $$;
create function public.review_finding(p_id uuid,p_text text,p_decision text,p_revision integer)
returns public.findings language sql security invoker set search_path = '' as $$
 select private.review_finding(p_id,p_text,p_decision,p_revision);
$$;
create function public.generate_report(p_project uuid)
returns public.reports language sql security invoker set search_path = '' as $$
 select private.generate_report(p_project);
$$;
revoke all on function private.review_finding(uuid,text,text,integer),private.generate_report(uuid) from public,anon;
grant execute on function private.review_finding(uuid,text,text,integer),private.generate_report(uuid) to authenticated;
revoke all on function public.review_finding(uuid,text,text,integer),public.generate_report(uuid) from public,anon;
grant execute on function public.review_finding(uuid,text,text,integer),public.generate_report(uuid) to authenticated;

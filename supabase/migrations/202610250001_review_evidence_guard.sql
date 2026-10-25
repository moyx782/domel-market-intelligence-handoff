-- Week 6: enforce evidence availability on the server, including direct RPC calls.
create or replace function private.review_finding(p_id uuid,p_text text,p_decision text,p_revision integer)
returns public.findings language plpgsql security definer set search_path = '' as $$
declare f public.findings; old_text text; changed boolean;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_decision not in ('pending','accepted','rejected') or p_decision is null then raise exception 'Invalid decision'; end if;
 if p_text is null or length(trim(p_text)) not between 1 and 4000 then raise exception 'Invalid finding wording'; end if;
 select * into f from public.findings where id=p_id for update;
 if not found or not exists(select 1 from public.projects where id=f.project_id and owner_id=auth.uid()) then raise exception 'Finding not accessible'; end if;
 if f.revision <> p_revision or p_revision is null then raise exception 'This finding changed. Refresh and try again.'; end if;
 if p_decision='accepted' and not exists(select 1 from public.sources s where s.id=f.source_id and s.project_id=f.project_id and length(f.quote)>=30 and position(f.quote in s.text)>0) then
  raise exception 'Supporting source or exact quote is unavailable. Do not approve this finding.';
 end if;
 old_text:=f.edited_text; changed:=trim(p_text)<>old_text;
 update public.findings set edited_text=trim(p_text),decision=case when changed then 'pending' else p_decision end,
 revision=revision+1,reviewer_id=case when changed or p_decision='pending' then null else auth.uid() end,
 reviewed_at=case when changed or p_decision='pending' then null else now() end where id=p_id returning * into f;
 insert into public.review_events(project_id,finding_id,actor_id,action,old_text,new_text,decision,revision)
 values(f.project_id,f.id,auth.uid(),case when changed then 'edit' else p_decision end,old_text,f.edited_text,f.decision,f.revision);
 return f;
end $$;

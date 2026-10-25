export type Decision = 'pending' | 'accepted' | 'rejected';
export type Project = {id:string;owner_id:string;title:string;question:string;segment:string;market:string;quarter:string;competitors:string[];focus:string[];source_urls:string[];status:string;stage:string;errors:string[];created_at:string;updated_at:string};
export type Source = {id:string;project_id:string;url:string;title:string;published_at:string|null;retrieved_at:string;text:string;competitor:string};
export type Finding = {id:string;project_id:string;source_id:string;competitor:string;field:string;original_text:string;edited_text:string;quote:string;decision:Decision;revision:number;reviewer_id:string|null;reviewed_at:string|null};
export type Audit = {id:string;finding_id:string;actor_id:string;action:string;old_text:string;new_text:string;decision:Decision;created_at:string;revision:number};
export type Report = {id:string;project_id:string;version:number;created_at:string;snapshot:{project:Project;findings:Finding[];sources:Source[];limitations:string[]}};
export type Bundle = {projects:Project[];sources:Source[];findings:Finding[];audits:Audit[];reports:Report[]};

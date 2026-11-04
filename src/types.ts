export type Decision = 'pending' | 'accepted' | 'rejected';
export type Project = {id:string;owner_id:string;title:string;question:string;segment:string;market:string;quarter:string;competitors:string[];focus:string[];source_urls:string[];status:string;stage:string;errors:string[];created_at:string;updated_at:string};
export type Source = {id:string;project_id:string;url:string;title:string;published_at:string|null;retrieved_at:string;text:string;competitor:string};
export type Finding = {id:string;project_id:string;source_id:string;competitor:string;field:string;original_text:string;edited_text:string;quote:string;decision:Decision;revision:number;reviewer_id:string|null;reviewed_at:string|null};
export type Audit = {id:string;finding_id:string;actor_id:string;action:string;old_text:string;new_text:string;decision:Decision;created_at:string;revision:number};
export type Report = {id:string;project_id:string;version:number;created_at:string;snapshot:{project:Project;findings:Finding[];sources:Source[];limitations:string[]}};
export type Bundle = {projects:Project[];sources:Source[];findings:Finding[];audits:Audit[];reports:Report[]};

// ---- Task queue (M1) -------------------------------------------------------

export type Role = 'viewer' | 'user' | 'admin' | 'system';
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskKind = 'event.discover' | 'event.enrich' | 'source.collect' | 'project.research' | 'project.extract';
export type LogLevel = 'info' | 'warn' | 'error';
export type TaskLogEntry = {at:string;message:string;level:LogLevel};
export type Task = {
 id:string;
 kind:TaskKind;
 state:TaskState;
 priority:number;
 effectivePriority:number;
 attempts:number;
 maxAttempts:number;
 notBefore:number;
 projectId:string|null;
 eventId:string|null;
 sourceId:string|null;
 payload:Record<string,unknown>;
 progress:string;
 result:unknown;
 error:string|null;
 log:TaskLogEntry[];
 createdAt:number;
 updatedAt:number;
 startedAt:number|null;
 finishedAt:number|null;
 cancelRequested?:boolean;
};
export type TaskStats = {queued:number;running:number;succeeded:number;failed:number;cancelled:number;[state:string]:number};
export type TaskStreamEvent =
 | {type:'snapshot';tasks:Task[];stats:TaskStats}
 | {type:'task';task:Task};

// ---- Events (M3c) ----------------------------------------------------------

export type EventStatus = 'discovered' | 'enriched' | 'verified' | 'archived';
export type Confidence = 'high' | 'medium' | 'low';
export type Availability = 'linked' | 'downloadable' | 'restricted' | 'unknown';
export type EventRegion = 'cn' | 'eu' | 'global';
export type EventDocument = {url:string;title?:string;type:string;status:Availability;parseProvider?:string;parsedAt?:string;pages?:number;chars?:number;textPath?:string};
export type EventMaterial = {
 id:string;
 url:string;
 title:string;
 kind:'document'|'webpage';
 provider:string;
 engine?:string;
 pages?:number|null;
 chars?:number|null;
 textPath?:string;
 summary?:string;
 agentSummary?:string;
 createdAt:string;
};
export type EventCompetitor = {name:string;participating:boolean|null;booth?:string;sourceUrl?:string};
export type EventSourceRef = {url:string;title:string;verifiedAt:string};
export type MarketEvent = {
 id:string;
 name:string;
 edition:number|null;
 startDate:string|null;
 endDate:string|null;
 city:string;
 province:string;
 district:string;
 country:string;
 venue:string;
 organizer:string;
 website:string;
 frequency:string;
 industries:string[];
 scope:string;
 exhibitorCount:number|null;
 visitorCount:number|null;
 area:string;
 exhibitorListUrl:string;
 exhibitorListStatus:Availability;
 documents:EventDocument[];
 materials:EventMaterial[];
 materialsReport:string;
 competitors:EventCompetitor[];
 applicationDeadline:string|null;
 boothPrice:string;
 ticketPrice:string;
 region:EventRegion;
 sources:EventSourceRef[];
 confidence:Confidence;
 status:EventStatus;
 notes:string[];
 createdAt:string;
 updatedAt:string;
};
export type EventListResponse = {events:MarketEvent[];count:number};
export type EventExportFormat = 'csv' | 'json';

// ---- Source registry / recipes (M3b) ---------------------------------------

export type SourceType = 'venue' | 'association' | 'organizer' | 'media' | 'site' | 'rss' | 'sitemap';
export type SourceStatus = 'idle' | 'running' | 'error' | 'paused' | 'manual';
export type SourceEntry = {
 id:string;
 url:string;
 domain:string;
 title:string;
 type:SourceType;
 region:EventRegion;
 enabled:boolean;
 priority:number;
 intervalSec:number;
 lastRunAt:string|null;
 nextRunAt:string|null;
 status:SourceStatus;
 lastError:string|null;
 discoveredBy:'human' | 'agent';
 createdAt:string;
 updatedAt:string;
};
export type SourceStats = {total:number;enabled:number;error:number;paused:number};
export type RecipeStatus = 'proposed' | 'approved' | 'disabled';
export type RecipeKind = 'script' | 'regex' | 'selectors';
export type Recipe = {
 id:string;
 domain:string;
 version:number;
 kind:RecipeKind;
 body:string;
 status:RecipeStatus;
 proposedBy:string;
 notes:string;
 createdAt:string;
 updatedAt:string;
};

// ---- Agent (M4/M5) ----------------------------------------------------------

export type McpServerConfig = {
 name:string;
 transport?:string;
 command?:string;
 args?:string[];
 url?:string;
 env?:Record<string,string>;
 headers?:Record<string,string>;
 enabled:boolean;
 exposure?:string;
};
export type McpTestResult = {ok:boolean;tools?:{name:string;description?:string}[];error?:string};
export type AgentSkill = {id:string;slug:string;name:string;description:string;enabled:boolean;path?:string;content?:string};
export type AgentPlugin = {id:string;slug:string;name:string;enabled:boolean;path?:string;file?:string};
export type OcrConfig = {provider:'none' | 'official' | 'local';localUrl:string;officialBase:string;tokenSet:boolean};
export type LlmConfig = {
 model:string;
 baseUrl:string;
 provider?:'deepseek' | 'custom';
 tokenSet?:boolean;
 keySet?:boolean;
 envKeySet?:boolean;
 effectiveConfigured?:boolean;
};
export type AgentConfig = {
 role:Role;
 cli:{enabled:boolean;allowBash:boolean};
 mcpServers:McpServerConfig[];
 skills:AgentSkill[];
 plugins:AgentPlugin[];
 ocr:OcrConfig;
 llm:LlmConfig;
};
export type AgentToolCall = {tool:string;ok:boolean;args?:string};
export type AgentTranscriptMessage = {role:'user' | 'assistant';text:string;at:string;toolCalls?:AgentToolCall[]};
export type AgentSessionSummary = {id:string;projectId:string;title:string;createdAt:string;updatedAt:string;messageCount:number};
export type AgentTranscript = {id:string;projectId:string;createdAt:string;updatedAt:string;messages:AgentTranscriptMessage[]};
export type AgentStreamEvent =
 | {type:'delta';text:string}
 | {type:'tool_start';tool:string;args?:string}
 | {type:'tool_end';tool:string;ok:boolean}
 | {type:'warning';message:string}
 | {type:'done';text:string;workspace?:string}
 | {type:'error';error:string};
export type Capabilities = {
 version:string;
 execution:string;
 environment:string;
 ai:boolean;
 search:boolean;
 assistant:boolean;
 agent:boolean;
 agent_role:Role | null;
 ocr:{provider:string;configured:boolean;baseUrl:string | null};
 max_sources:number;
 allowed_domains:string[];
 default_source_urls:string[];
 discovery_mode:string;
 queue?:{file:string;concurrency:number};
 collector?:{playwright:boolean};
 events?:{count:number};
 sources?:{total:number};
};

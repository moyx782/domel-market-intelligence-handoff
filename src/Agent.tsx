// Agent page (M5): a streaming Pi-agent chat with tool cards, run history and a
// viewer-friendly read-only transcript. Viewers never see the composer; the
// history endpoint is readable by every role.
import {useCallback,useEffect,useRef,useState} from 'react';
import {
 AlertCircle, BadgeCheck, Bot, Check, ChevronRight, Clock, History,
 LoaderCircle, MessageSquare, RefreshCw, Send, Sparkles, Square, User, Wrench, X,
} from 'lucide-react';
import {getAgentSessions, getAgentTranscript, streamAgentChat} from './api';
import {locale, useI18n} from './i18n';
import type {AgentSessionSummary, AgentStreamEvent, AgentToolCall, AgentTranscript, Project, Role} from './types';
import './messages-events';

type ToolRun = {id: number; tool: string; args?: string; ok: boolean | null};
type Turn = {
 id: number;
 user: string;
 assistant: string;
 tools: ToolRun[];
 warnings: string[];
 error: string;
 workspace: string;
 running: boolean;
 finished: boolean;
 aborted: boolean;
};

function time(value: string, lang: 'en' | 'zh') {
 const parsed = new Date(value);
 if (Number.isNaN(parsed.getTime())) return value;
 return parsed.toLocaleString(locale(lang), {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function readTranscriptText(message: {role: 'user' | 'assistant'; text: string}) {
 return message.text || '';
}

function ToolStatus({ok}: {ok: boolean | null}) {
 const {t} = useI18n();
 if (ok === null) return <span className="agent-tool-status running"><LoaderCircle className="spin" size={13}/>{t('Running')}</span>;
 return ok
  ? <span className="agent-tool-status ok"><Check size={13}/>{t('OK')}</span>
  : <span className="agent-tool-status failed"><X size={13}/>{t('Failed')}</span>;
}

function TranscriptToolCalls({calls}: {calls: AgentToolCall[]}) {
 const {t} = useI18n();
 if (!calls.length) return null;
 return <ul className="agent-tool-cards transcript">
  {calls.map((call, index) => <li key={call.tool + index} className="agent-tool">
   <Wrench size={13}/>
   <code>{call.tool}</code>
   {call.args && <span className="agent-tool-args" title={call.args}>{call.args}</span>}
   <ToolStatus ok={call.ok}/>
  </li>)}
 </ul>;
}

function SessionTranscript({transcript, onClose}: {transcript: AgentTranscript; onClose: () => void}) {
 const {t, lang} = useI18n();
 return <section className="panel agent-transcript" aria-label={t('Session transcript')}>
  <div className="agent-transcript-head">
   <div>
    <span className="eyebrow">{t('READ-ONLY TRANSCRIPT')}</span>
    <h2>{t('Session from {date}', {date: time(transcript.createdAt, lang)})}</h2>
   </div>
   <button className="ev-icon-btn" aria-label={t('Close transcript')} onClick={onClose}><X size={16}/></button>
  </div>
  <div className="agent-transcript-body">
   {transcript.messages.length === 0 && <p className="small">{t('This session has no recorded messages.')}</p>}
   {transcript.messages.map((message, index) => <div key={index} className={'agent-bubble ' + message.role}>
    <span className="agent-bubble-label">{message.role === 'user' ? t('You') : t('Assistant')}</span>
    <p>{readTranscriptText(message)}</p>
    {message.toolCalls && <TranscriptToolCalls calls={message.toolCalls}/>}
    <small className="agent-bubble-time">{time(message.at, lang)}</small>
   </div>)}
  </div>
 </section>;
}

export default function Agent({role, projects}: {role: Role; projects: Project[]}) {
 const {t, lang} = useI18n();
 const canChat = role !== 'viewer';

 const [projectId, setProjectId] = useState('general');
 const [turns, setTurns] = useState<Turn[]>([]);
 const [input, setInput] = useState('');
 const [running, setRunning] = useState(false);

 const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
 const [historyLoading, setHistoryLoading] = useState(false);
 const [historyError, setHistoryError] = useState('');
 const [openSessionId, setOpenSessionId] = useState<string | null>(null);
 const [transcript, setTranscript] = useState<AgentTranscript | null>(null);
 const [transcriptLoading, setTranscriptLoading] = useState(false);
 const [transcriptError, setTranscriptError] = useState('');

 const turnSeq = useRef(0);
 const toolSeq = useRef(0);
 const controllerRef = useRef<AbortController | null>(null);
 const openSessionRef = useRef<string | null>(null);
 const logRef = useRef<HTMLDivElement | null>(null);
 const inputRef = useRef<HTMLTextAreaElement | null>(null);

 const loadSessions = useCallback(async () => {
  setHistoryLoading(true);
  setHistoryError('');
  try {
   const payload = await getAgentSessions(projectId);
   setSessions(payload.sessions ?? []);
  } catch (cause) {
   setSessions([]);
   setHistoryError(cause instanceof Error ? cause.message : String(cause));
  } finally {
   setHistoryLoading(false);
  }
 }, [projectId]);

 useEffect(() => {
  setTurns([]);
  setOpenSessionId(null);
  setTranscript(null);
  setTranscriptError('');
  void loadSessions();
 }, [projectId, loadSessions]);

 // Abort an in-flight run if the page unmounts; the server sees the closed
 // request and stops the Pi session.
 useEffect(() => () => { controllerRef.current?.abort(); }, []);

 // Follow streaming output.
 useEffect(() => {
  const node = logRef.current;
  if (node) node.scrollTop = node.scrollHeight;
 }, [turns]);

 function applyEvent(turnId: number, event: AgentStreamEvent) {
  setTurns(previous => previous.map(turn => {
   if (turn.id !== turnId) return turn;
   switch (event.type) {
    case 'delta':
     return {...turn, assistant: turn.assistant + event.text};
    case 'tool_start':
     return {...turn, tools: [...turn.tools, {id: ++toolSeq.current, tool: event.tool, args: event.args, ok: null}]};
    case 'tool_end': {
     // The runtime sends matching start/end pairs; mark the most recent pending
     // invocation of that tool so parallel cards stay in order.
     let pending = -1;
     for (let index = turn.tools.length - 1; index >= 0; index -= 1) {
      if (turn.tools[index].ok === null && turn.tools[index].tool === event.tool) { pending = index; break; }
     }
     if (pending < 0) return {...turn, tools: [...turn.tools, {id: ++toolSeq.current, tool: event.tool, ok: event.ok}]};
     const tools = turn.tools.map((tool, index) => index === pending ? {...tool, ok: event.ok} : tool);
     return {...turn, tools};
    }
    case 'warning':
     return {...turn, warnings: [...turn.warnings, event.message]};
    case 'done':
     return {...turn, assistant: turn.assistant || event.text, workspace: event.workspace ?? '', running: false, finished: true};
    case 'error':
     return {...turn, error: event.error, running: false, finished: true};
    default:
     return turn;
   }
  }));
  if (event.type === 'done' || event.type === 'error') {
   controllerRef.current = null;
   setRunning(false);
   void loadSessions();
  }
 }

 function send() {
  if (!canChat || running) return;
  const message = input.trim();
  if (!message) return;
  const turnId = ++turnSeq.current;
  setTurns(previous => [...previous, {
   id: turnId, user: message, assistant: '', tools: [], warnings: [],
   error: '', workspace: '', running: true, finished: false, aborted: false,
  }]);
  setInput('');
  setRunning(true);
  setOpenSessionId(null);
  setTranscript(null);
  const controller = new AbortController();
  controllerRef.current = controller;
  streamAgentChat({
   projectId,
   message,
   signal: controller.signal,
   onEvent: event => applyEvent(turnId, event),
  });
 }

 function stop() {
  if (!running) return;
  controllerRef.current?.abort();
  controllerRef.current = null;
  setRunning(false);
  setTurns(previous => previous.map(turn => turn.running
   ? {...turn, running: false, finished: true, aborted: true}
   : turn));
 }

 function newSession() {
  stop();
  setTurns([]);
  setInput('');
  setOpenSessionId(null);
  setTranscript(null);
  setTranscriptError('');
  window.setTimeout(() => inputRef.current?.focus(), 0);
 }

 async function openSession(id: string) {
  openSessionRef.current = id;
  setOpenSessionId(id);
  setTranscript(null);
  setTranscriptError('');
  setTranscriptLoading(true);
  try {
   const payload = await getAgentTranscript(id);
   if (openSessionRef.current !== id) return;
   setTranscript(payload);
  } catch (cause) {
   if (openSessionRef.current !== id) return;
   setTranscriptError(cause instanceof Error ? cause.message : String(cause));
  } finally {
   if (openSessionRef.current === id) setTranscriptLoading(false);
  }
 }

 function closeTranscript() {
  openSessionRef.current = null;
  setOpenSessionId(null);
  setTranscript(null);
  setTranscriptError('');
  setTranscriptLoading(false);
 }

 const projectTitle = projectId === 'general'
  ? t('General workspace')
  : projects.find(project => project.id === projectId)?.title ?? projectId;

 return <div className="agent-page">
  <div className="page-heading">
   <div>
    <div className="eyebrow">{t('AGENT WORKSPACE')}</div>
    <h1>{t('Agent')}</h1>
    <p>{t('Ask the research agent to inspect the workspace and use its tools. Every run is recorded for review.')}</p>
   </div>
   <div className="agent-heading-actions">
    <label className="agent-project-select">
     <span>{t('Project')}</span>
     <select
      aria-label={t('Select agent project')}
      value={projectId}
      onChange={event => setProjectId(event.target.value)}
      disabled={running}
     >
      <option value="general">{t('General workspace')}</option>
      {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
     </select>
    </label>
    <button className="secondary" onClick={newSession} disabled={running && turns.length === 0}>
     <Sparkles size={15}/>{t('New session')}
    </button>
   </div>
  </div>

  <div className="agent-layout">
   <section className="panel agent-chat">
    <div className="panel-heading agent-chat-head">
     <div>
      <h2><Bot size={17}/>{t('Conversation')} <span className="count">{turns.length}</span></h2>
      <p>{projectTitle}</p>
     </div>
     <span className={'agent-run-state ' + (running ? 'running' : 'idle')}>
      {running ? <><LoaderCircle className="spin" size={14}/>{t('Running')}</> : <><Check size={14}/>{t('Ready')}</>}
     </span>
    </div>

    <div className="agent-log" ref={logRef}>
     {turns.length === 0 && <div className="agent-empty">
      <MessageSquare size={28}/>
      <h2>{t('Start a conversation')}</h2>
      <p>{canChat
       ? t('The agent can read the workspace, run tools and prepare evidence. It cannot approve findings for you.')
       : t('Viewers can read the recorded sessions in the history panel. Starting a run needs the user role.')}</p>
      {canChat && <div className="agent-suggestions">
       {[
        'Summarize the latest trade show data in the workspace.',
        'Which events are missing dates or venues?',
        'Draft a visit checklist for the next China trade show.',
       ].map(suggestion => <button type="button" key={suggestion} onClick={() => setInput(t(suggestion))}>{t(suggestion)}</button>)}
      </div>}
     </div>}

     {turns.map(turn => <div className="agent-turn" key={turn.id}>
      <div className="agent-bubble user">
       <span className="agent-bubble-label"><User size={13}/>{t('You')}</span>
       <p>{turn.user}</p>
      </div>

      <div className="agent-bubble assistant">
       <span className="agent-bubble-label"><Bot size={13}/>{t('Assistant')}</span>
       {turn.assistant && <p>{turn.assistant}</p>}
       {!turn.assistant && turn.running && <p className="agent-thinking"><LoaderCircle className="spin" size={14}/>{t('Thinking…')}</p>}
       {!turn.assistant && !turn.running && turn.aborted && <p className="agent-muted">{t('Stopped by user.')}</p>}
       {!turn.assistant && !turn.running && turn.error && <div role="alert" className="alert error">{t(turn.error)}</div>}
       {!turn.assistant && !turn.running && turn.finished && !turn.error && !turn.aborted && <p className="agent-muted">{t('No assistant text was returned.')}</p>}

       {turn.tools.length > 0 && <ul className="agent-tool-cards">
        {turn.tools.map(tool => <li className="agent-tool" key={tool.id}>
         <Wrench size={13}/>
         <code>{tool.tool}</code>
         {tool.args && <span className="agent-tool-args" title={tool.args}>{tool.args}</span>}
         <ToolStatus ok={tool.ok}/>
        </li>)}
       </ul>}

       {turn.warnings.map((warning, index) => <div className="agent-warning" key={index}>
        <AlertCircle size={14}/><span>{warning}</span>
       </div>)}

       {turn.error && <div role="alert" className="alert error">
        <AlertCircle size={16}/><span>{t(turn.error)}</span>
       </div>}

       {turn.finished && !turn.aborted && !turn.error && <div className="agent-done">
        <BadgeCheck size={14}/>{t('Run finished')}
        {turn.workspace && <code className="agent-workspace" title={turn.workspace}>{turn.workspace}</code>}
       </div>}
      </div>
     </div>)}
    </div>

    {canChat
     ? <form className="agent-composer" onSubmit={event => { event.preventDefault(); send(); }}>
       <textarea
        ref={inputRef}
        rows={2}
        aria-label={t('Message the agent')}
        placeholder={t('Ask the agent… (Enter to send, Shift+Enter for a new line)')}
        value={input}
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => {
         if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
         else if (event.key === 'Escape' && running) { event.preventDefault(); stop(); }
        }}
        disabled={running}
       />
       <div className="agent-composer-actions">
        <span className="small">{running ? t('The agent is running. Stop it before sending another message.') : t('Enter sends · Esc stops a running agent')}</span>
        {running
         ? <button type="button" className="secondary agent-stop" onClick={stop}><Square size={14}/>{t('Stop')}</button>
         : <button type="submit" className="primary" disabled={!input.trim()}><Send size={15}/>{t('Send')}</button>}
       </div>
      </form>
     : <div className="agent-viewer-note">
       <AlertCircle size={16}/><span>{t('Viewers can read agent history only. Starting a run requires the user role.')}</span>
      </div>}
   </section>

   <aside className="panel agent-history" aria-label={t('Agent session history')}>
    <div className="agent-history-head">
     <div>
      <h2><History size={16}/>{t('Session history')} <span className="count">{sessions.length}</span></h2>
      <p>{t('Recorded runs for {project}', {project: projectTitle})}</p>
     </div>
     <button className="ev-icon-btn" aria-label={t('Refresh history')} onClick={() => void loadSessions()} disabled={historyLoading}>
      <RefreshCw size={15} className={historyLoading ? 'spin' : ''}/>
     </button>
    </div>

    {historyError && <div role="alert" className="alert error agent-history-error">
     <AlertCircle size={16}/><span>{t(historyError)}</span>
    </div>}
    {historyLoading && sessions.length === 0 && <p className="small agent-history-empty"><LoaderCircle className="spin" size={15}/>{t('Loading history…')}</p>}
    {!historyLoading && !historyError && sessions.length === 0 && <p className="small agent-history-empty">
     {t('No recorded sessions for this project yet.')}
    </p>}

    {sessions.length > 0 && <ul className="agent-session-list">
     {sessions.map(session => <li key={session.id}>
      <button
       type="button"
       className={'agent-session' + (openSessionId === session.id ? ' active' : '')}
       onClick={() => void openSession(session.id)}
       aria-pressed={openSessionId === session.id}
      >
       <span className="agent-session-title">{session.title}</span>
       <span className="agent-session-meta">
        <Clock size={12}/>{time(session.updatedAt, lang)}
        <span>·</span>{t('{count} messages', {count: session.messageCount})}
       </span>
       <ChevronRight size={14} className="agent-session-chevron"/>
      </button>
     </li>)}
    </ul>}

    {transcriptLoading && <p className="small agent-history-empty"><LoaderCircle className="spin" size={15}/>{t('Loading transcript…')}</p>}
    {transcriptError && <div role="alert" className="alert error agent-history-error">
     <AlertCircle size={16}/><span>{t(transcriptError)}</span>
    </div>}
   </aside>
  </div>

  {transcript && <SessionTranscript transcript={transcript} onClose={closeTranscript}/>}
 </div>;
}

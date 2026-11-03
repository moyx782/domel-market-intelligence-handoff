// Settings (M4): keeps the role/agent-tools/OCR sections working and adds
// management for MCP servers, skills, plugins and scraper recipes. Every call
// goes through src/api.ts; role handling has three states: viewer read-only,
// user toggle-only, admin/system full management.
import {useCallback,useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import {
 AlertCircle, BookOpen, Check, KeyRound, LoaderCircle, Plus, Puzzle,
 RefreshCw, Save, Server, ShieldCheck, Terminal, Trash2, Wrench, X,
} from 'lucide-react';
import {
 addMcp, addPlugin, addSkill, deleteMcp, deletePlugin, deleteSkill,
 getAgentConfig, getRawMcp, listRecipes, replaceMcp, testMcp,
 updateAgentSettings, updateMcp, updatePlugin, updateSkill, updateRecipe,
} from './api';
import {useI18n} from './i18n';
import type {
 AgentConfig, AgentPlugin, AgentSkill, McpServerConfig, McpTestResult, Recipe, Role,
} from './types';
import './messages-events';

type SkillDraft = {name: string; description: string; content: string};

function message(cause: unknown) {
 return cause instanceof Error ? cause.message : String(cause);
}

function recipeLabelKey(status: Recipe['status']) {
 return status === 'proposed' ? 'Proposed' : status === 'approved' ? 'Approved' : 'Disabled';
}

export default function Settings({onRoleChanged}: {onRoleChanged?: () => void}) {
 const {t} = useI18n();
 const [config, setConfig] = useState<AgentConfig | null>(null);
 const [provider, setProvider] = useState<'none' | 'official' | 'local'>('none');
 const [endpoint, setEndpoint] = useState('');
 const [token, setToken] = useState('');
 const [clearToken, setClearToken] = useState(false);
 const [role, setRole] = useState<Role>('admin');
 const [cliEnabled, setCliEnabled] = useState(true);
 const [cliBash, setCliBash] = useState(true);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [busy, setBusy] = useState('');
 const [loadError, setLoadError] = useState('');

 // MCP
 const [rawJson, setRawJson] = useState('');
 const [rawLoading, setRawLoading] = useState(false);
 const [mcpTests, setMcpTests] = useState<Record<string, McpTestResult | null>>({});
 const [showMcpForm, setShowMcpForm] = useState(false);
 const [mcpName, setMcpName] = useState('');
 const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio');
 const [mcpCommand, setMcpCommand] = useState('');
 const [mcpArgs, setMcpArgs] = useState('');
 const [mcpUrl, setMcpUrl] = useState('');

 // Skills
 const [skillDrafts, setSkillDrafts] = useState<Record<string, SkillDraft>>({});
 const [openSkillId, setOpenSkillId] = useState<string | null>(null);
 const [showSkillForm, setShowSkillForm] = useState(false);
 const [skillName, setSkillName] = useState('');
 const [skillDescription, setSkillDescription] = useState('');
 const [skillContent, setSkillContent] = useState('');

 // Plugins
 const [showPluginForm, setShowPluginForm] = useState(false);
 const [pluginName, setPluginName] = useState('');
 const [pluginContent, setPluginContent] = useState('');

 // Recipes
 const [recipes, setRecipes] = useState<Recipe[]>([]);
 const [recipesLoading, setRecipesLoading] = useState(false);
 const [recipesError, setRecipesError] = useState('');

 const load = useCallback(async () => {
  try {
   const next = await getAgentConfig();
   setConfig(next);
   setLoadError('');
   setRole(next.role);
   setCliEnabled(next.cli?.enabled ?? true);
   setCliBash(next.cli?.allowBash ?? true);
   const nextProvider = next.ocr?.provider ?? 'none';
   setProvider(nextProvider);
   setEndpoint(nextProvider === 'local'
    ? (next.ocr?.localUrl || 'http://127.0.0.1:8000')
    : (nextProvider === 'official' ? (next.ocr?.officialBase || 'https://mineru.net/api/v4') : ''));
   setSkillDrafts(Object.fromEntries(next.skills.map(skill => [skill.id, {
    name: skill.name, description: skill.description, content: skill.content ?? '',
   }])));
  } catch (cause) {
   setLoadError(message(cause));
  }
 }, []);

 useEffect(() => { void load(); }, [load]);

 const isAdmin = config?.role === 'admin' || config?.role === 'system';
 const isSystem = config?.role === 'system';
 const canToggle = config?.role !== 'viewer';

 const loadRaw = useCallback(async () => {
  setRawLoading(true);
  setRawJson('');
  try {
   const payload = await getRawMcp();
   setRawJson(JSON.stringify(payload, null, 2));
  } catch (cause) {
   setRawJson('');
   setError(message(cause));
  } finally {
   setRawLoading(false);
  }
 }, []);

 // Raw mcp.json is only readable by admins; other roles get the (masked)
 // public config as a read-only snapshot.
 useEffect(() => {
  if (config && isAdmin) void loadRaw();
 }, [config, isAdmin, loadRaw]);

 const loadRecipes = useCallback(async () => {
  setRecipesLoading(true);
  setRecipesError('');
  try {
   const payload = await listRecipes();
   setRecipes(payload.recipes ?? []);
  } catch (cause) {
   setRecipes([]);
   setRecipesError(message(cause));
  } finally {
   setRecipesLoading(false);
  }
 }, []);

 useEffect(() => { void loadRecipes(); }, [loadRecipes]);

 function notify(text: string) {
  setNotice(text);
  setError('');
 }

 async function run(action: string, work: () => Promise<void>) {
  setBusy(action);
  setError('');
  setNotice('');
  try {
   await work();
  } catch (cause) {
   setError(message(cause));
  } finally {
   setBusy('');
  }
 }

 // ---- Legacy sections (role, CLI, OCR) -------------------------------------

 async function saveRole() {
  await run('role', async () => {
   await updateAgentSettings({role});
   await load();
   onRoleChanged?.();
   notify(t('Role updated'));
  });
 }

 async function saveCli() {
  await run('cli', async () => {
   await updateAgentSettings({cli: {enabled: cliEnabled, allowBash: cliBash}});
   await load();
   notify(t('Tools updated'));
  });
 }

 async function saveOcr() {
  await run('ocr', async () => {
   const ocr: {provider: string; localUrl?: string; officialBase?: string; token?: string} = {provider};
   if (provider === 'local') ocr.localUrl = endpoint;
   if (provider === 'official') ocr.officialBase = endpoint;
   if (clearToken) ocr.token = '';
   else if (token) ocr.token = token;
   await updateAgentSettings({ocr});
   setToken('');
   setClearToken(false);
   await load();
   notify(t('Saved'));
  });
 }

 // ---- MCP ------------------------------------------------------------------

 async function saveRaw() {
  let parsed: unknown;
  try {
   parsed = JSON.parse(rawJson);
  } catch {
   setError(t('MCP JSON is not valid. Fix the syntax before saving.'));
   return;
  }
  await run('raw', async () => {
   await replaceMcp(parsed as Record<string, unknown>);
   await load();
   if (isAdmin) await loadRaw();
   notify(t('MCP configuration saved.'));
  });
 }

 async function toggleMcp(server: McpServerConfig) {
  await run('mcp:' + server.name, async () => {
   await updateMcp(server.name, {enabled: !server.enabled});
   await load();
   notify(server.enabled ? t('MCP server disabled.') : t('MCP server enabled.'));
  });
 }

 async function probeMcp(name: string) {
  setBusy('test:' + name);
  setError('');
  setMcpTests(previous => ({...previous, [name]: null}));
  try {
   const result = await testMcp(name);
   setMcpTests(previous => ({...previous, [name]: result}));
  } catch (cause) {
   setMcpTests(previous => ({...previous, [name]: {ok: false, error: message(cause)}}));
  } finally {
   setBusy('');
  }
 }

 function resetMcpForm() {
  setMcpName('');
  setMcpTransport('stdio');
  setMcpCommand('');
  setMcpArgs('');
  setMcpUrl('');
  setShowMcpForm(false);
 }

 async function submitMcp(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const name = mcpName.trim();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) {
   setError(t('Use 1–40 letters, digits, dashes or underscores for the server name.'));
   return;
  }
  if (mcpTransport === 'http' && !/^https?:\/\//.test(mcpUrl.trim())) {
   setError(t('Enter an http(s) URL for the MCP server.'));
   return;
  }
  if (mcpTransport === 'stdio' && !mcpCommand.trim()) {
   setError(t('Enter the command that starts the MCP server.'));
   return;
  }
  await run('add-mcp', async () => {
   const body: Record<string, unknown> = {name, transport: mcpTransport};
   if (mcpTransport === 'http') body.url = mcpUrl.trim();
   else {
    body.command = mcpCommand.trim();
    body.args = mcpArgs.split(/\s+/).filter(Boolean);
   }
   await addMcp(body);
   resetMcpForm();
   await load();
   if (isAdmin) await loadRaw();
   notify(t('MCP server added.'));
  });
 }

 async function removeMcp(name: string) {
  await run('del-mcp:' + name, async () => {
   await deleteMcp(name);
   await load();
   if (isAdmin) await loadRaw();
   notify(t('MCP server removed.'));
  });
 }

 // ---- Skills ---------------------------------------------------------------

 function draftFor(skill: AgentSkill): SkillDraft {
  return skillDrafts[skill.id] ?? {name: skill.name, description: skill.description, content: skill.content ?? ''};
 }

 function updateDraft(id: string, patch: Partial<SkillDraft>) {
  setSkillDrafts(previous => ({
   ...previous,
   [id]: {...(previous[id] ?? {name: '', description: '', content: ''}), ...patch},
  }));
 }

 async function toggleSkill(skill: AgentSkill) {
  await run('skill:' + skill.id, async () => {
   await updateSkill(skill.id, {enabled: !skill.enabled});
   await load();
   notify(skill.enabled ? t('Skill disabled.') : t('Skill enabled.'));
  });
 }

 async function saveSkill(id: string) {
  const draft = skillDrafts[id];
  if (!draft || !draft.name.trim()) {
   setError(t('Skill name is required.'));
   return;
  }
  await run('skill:' + id, async () => {
   await updateSkill(id, {name: draft.name.trim(), description: draft.description, content: draft.content});
   await load();
   notify(t('Skill saved.'));
  });
 }

 async function removeSkill(id: string) {
  await run('del-skill:' + id, async () => {
   await deleteSkill(id);
   if (openSkillId === id) setOpenSkillId(null);
   await load();
   notify(t('Skill removed.'));
  });
 }

 async function submitSkill(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (!skillName.trim()) {
   setError(t('Skill name is required.'));
   return;
  }
  await run('add-skill', async () => {
   await addSkill({name: skillName.trim(), description: skillDescription.trim(), content: skillContent});
   setSkillName('');
   setSkillDescription('');
   setSkillContent('');
   setShowSkillForm(false);
   await load();
   notify(t('Skill added.'));
  });
 }

 // ---- Plugins --------------------------------------------------------------

 async function togglePlugin(plugin: AgentPlugin) {
  await run('plugin:' + plugin.id, async () => {
   await updatePlugin(plugin.id, {enabled: !plugin.enabled});
   await load();
   notify(plugin.enabled ? t('Plugin disabled.') : t('Plugin enabled.'));
  });
 }

 async function removePlugin(id: string) {
  await run('del-plugin:' + id, async () => {
   await deletePlugin(id);
   await load();
   notify(t('Plugin removed.'));
  });
 }

 async function submitPlugin(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (!pluginName.trim()) {
   setError(t('Plugin name is required.'));
   return;
  }
  await run('add-plugin', async () => {
   await addPlugin({name: pluginName.trim(), ...(pluginContent ? {content: pluginContent} : {})});
   setPluginName('');
   setPluginContent('');
   setShowPluginForm(false);
   await load();
   notify(t('Plugin added.'));
  });
 }

 // ---- Recipes --------------------------------------------------------------

 async function setRecipeStatus(recipe: Recipe, status: 'approved' | 'disabled') {
  await run('recipe:' + recipe.id, async () => {
   await updateRecipe(recipe.id, {status});
   await loadRecipes();
   notify(status === 'approved' ? t('Recipe approved.') : t('Recipe disabled.'));
  });
 }

 if (!config) {
  return <section className="panel padded">
   {loadError
    ? <div role="alert" className="alert error">
      <AlertCircle size={17}/><span>{t(loadError)}</span>
      <button className="secondary" onClick={() => void load()}><RefreshCw size={15}/>{t('Retry')}</button>
     </div>
    : <p className="muted"><LoaderCircle className="spin" size={15}/> {t('Loading…')}</p>}
  </section>;
 }

 const mcpServers = config.mcpServers ?? [];
 const skills = config.skills ?? [];
 const plugins = config.plugins ?? [];
 const rawValue = rawJson || JSON.stringify({mcpServers}, null, 2);

 return <div className="settings-page">
  <div className="page-heading">
   <div><h1>{t('Settings')}</h1><p>{t('Manage roles, document parsing and integrations for this workspace.')}</p></div>
   <span className="step-label">{config.role}</span>
  </div>
  {!isAdmin && <div className="alert"><AlertCircle size={17}/>{t('Only admins can change workspace settings.')}</div>}
  {error && <div role="alert" className="alert error">
   <AlertCircle size={17}/><span>{t(error)}</span>
   <button aria-label={t('Dismiss error')} onClick={() => setError('')}><X size={15}/></button>
  </div>}
  {notice && <div role="status" className="alert success"><Check size={17}/>{t(notice)}</div>}

  <section className="panel padded">
   <div className="settings-section-head"><ShieldCheck size={18}/><div><h2>{t('Role & access')}</h2><p>{t('Admin manages roles; the system (T0) role is only set from the local CLI.')}</p></div></div>
   <div className="settings-grid">
    <label>{t('Workspace role')}
     {config.role === 'system'
      ? <input value="system (T0)" readOnly/>
      : <select value={role} onChange={event => setRole(event.target.value as Role)} disabled={!isAdmin}>
        <option value="admin">admin</option>
        <option value="user">user</option>
        <option value="viewer">viewer</option>
       </select>}
    </label>
   </div>
   {isAdmin && config.role !== 'system' && <>
    <p className="small">{t('Downgrading a role requires the local CLI to restore admin access.')}</p>
    <div className="review-actions"><button className="primary" onClick={() => void saveRole()} disabled={busy === 'role'}><Save size={16}/>{t('Save role')}</button></div>
   </>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><Terminal size={18}/><div><h2>{t('Agent tools')}</h2><p>{t('Controls what the agent can do in its local workspace. Only the system (T0) role can change these switches.')}</p></div></div>
   <div className="settings-grid">
    <label>{t('File read/write')}
     <select value={cliEnabled ? 'on' : 'off'} onChange={event => setCliEnabled(event.target.value === 'on')} disabled={!isSystem}>
      <option value="on">{t('Enabled')}</option>
      <option value="off">{t('Disabled')}</option>
     </select>
    </label>
    <label>{t('Shell commands')}
     <select value={cliBash ? 'on' : 'off'} onChange={event => setCliBash(event.target.value === 'on')} disabled={!isSystem || !cliEnabled}>
      <option value="on">{t('Enabled')}</option>
      <option value="off">{t('Disabled')}</option>
     </select>
    </label>
   </div>
   {isSystem && <div className="review-actions"><button className="primary" onClick={() => void saveCli()} disabled={busy === 'cli'}><Save size={16}/>{t('Save tools')}</button></div>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><KeyRound size={18}/><div><h2>{t('Document parsing')}</h2><p>{t('MinerU converts PDFs and scanned exhibitor lists. Links and availability are shown even when parsing is disabled.')}</p></div></div>
   <div className="settings-grid">
    <label>{t('OCR provider')}
     <select value={provider} onChange={event => {
      const next = event.target.value as 'none' | 'official' | 'local';
      setProvider(next);
      if (next === 'official') setEndpoint('https://mineru.net/api/v4');
      else if (next === 'local') setEndpoint('http://127.0.0.1:8000');
      else setEndpoint('');
     }} disabled={!isAdmin}>
      <option value="none">{t('Disabled')}</option>
      <option value="official">{t('MinerU official API')}</option>
      <option value="local">{t('Self-hosted MinerU')}</option>
     </select>
    </label>
    <label>{t('API endpoint')}
     <input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder={provider === 'local' ? 'http://127.0.0.1:8000' : 'https://mineru.net/api/v4'} disabled={!isAdmin || provider === 'none'}/>
    </label>
    <label>{t('API token')}
     <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="new-password" placeholder={config.ocr.tokenSet ? t('Configured — leave blank to keep') : t('Not configured')} disabled={!isAdmin || provider !== 'official'}/>
    </label>
   </div>
   <p className="small">{t('Choosing a provider fills its default endpoint; you can override it.')}</p>
   <p className="small">{t('Tokens are write-only: they can be replaced or cleared, but never displayed again.')}</p>
   {isAdmin && <div className="review-actions">
    <button className="primary" onClick={() => void saveOcr()} disabled={busy === 'ocr'}><Save size={16}/>{t('Save settings')}</button>
    {config.ocr.tokenSet && <button className="secondary" onClick={() => setClearToken(true)} disabled={busy === 'ocr'}>{t('Clear token')}</button>}
   </div>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><Server size={18}/><div><h2>{t('MCP servers')}</h2><p>{t('MCP servers give the agent extra tools. The agent/mcp.json file is the source of truth.')}</p></div></div>
   {!isAdmin && <p className="small">{canToggle
    ? t('You can enable or disable MCP servers. Only admins can add, test, edit or remove them.')
    : t('Viewers can read the MCP configuration but cannot change it.')}</p>}
   {mcpServers.length === 0
    ? <p className="small settings-empty">{t('No MCP servers configured yet.')}</p>
    : <ul className="settings-list">
      {mcpServers.map(server => {
       const test = mcpTests[server.name];
       return <li className="settings-row" key={server.name}>
        <div className="settings-row-main">
         <strong>{server.name}</strong>
         <span className="settings-meta">
          {t('Transport: {transport}', {transport: server.transport ?? (server.url ? 'http' : 'stdio')})}
          {server.command ? ' · ' + server.command : server.url ? ' · ' + server.url : ''}
          {server.enabled ? '' : ' · ' + t('Disabled')}
         </span>
        </div>
        <div className="settings-row-actions">
         {isAdmin && <button className="secondary" onClick={() => void probeMcp(server.name)} disabled={busy === 'test:' + server.name}>
          {busy === 'test:' + server.name ? <LoaderCircle className="spin" size={14}/> : <Wrench size={14}/>}{t('Test connection')}
         </button>}
         {isAdmin && <button className="secondary danger" onClick={() => void removeMcp(server.name)} disabled={busy === 'del-mcp:' + server.name} aria-label={t('Remove MCP server {name}', {name: server.name})}>
          <Trash2 size={14}/>{t('Remove')}
         </button>}
         <label className="settings-switch">
          <input
           type="checkbox"
           checked={server.enabled}
           onChange={() => void toggleMcp(server)}
           disabled={!canToggle || busy === 'mcp:' + server.name}
           aria-label={t('Enable MCP server {name}', {name: server.name})}
          />
          {t('Enabled')}
         </label>
        </div>
        {test && <div className={'settings-test ' + (test.ok ? 'ok' : 'error')}>
         {test.ok
          ? <><Check size={14}/><span>{t('Connected · {count} tools', {count: test.tools?.length ?? 0})}</span>
           {test.tools && test.tools.length > 0 && <ul className="settings-tools">
            {test.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <span>{tool.description}</span>}</li>)}
           </ul>}
          </>
          : <><AlertCircle size={14}/><span>{t(test.error || 'Connection test failed')}</span></>}
        </div>}
       </li>;
      })}
     </ul>}

   {isAdmin && <>
    <div className="review-actions">
     <button className="secondary" onClick={() => setShowMcpForm(!showMcpForm)}><Plus size={15}/>{showMcpForm ? t('Close form') : t('Add MCP server')}</button>
     <button className="secondary" onClick={() => void loadRaw()} disabled={rawLoading}>{rawLoading ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>}{t('Reload raw JSON')}</button>
    </div>
    {showMcpForm && <form className="settings-editor" onSubmit={event => void submitMcp(event)}>
     <div className="settings-grid">
      <label>{t('Server name')}<input value={mcpName} onChange={event => setMcpName(event.target.value)} placeholder="qichacha" maxLength={40}/></label>
      <label>{t('Transport')}<select value={mcpTransport} onChange={event => setMcpTransport(event.target.value as 'stdio' | 'http')}>
       <option value="stdio">stdio</option>
       <option value="http">http</option>
      </select></label>
     </div>
     {mcpTransport === 'stdio'
      ? <>
       <label>{t('Command')}<input value={mcpCommand} onChange={event => setMcpCommand(event.target.value)} placeholder="/usr/local/bin/npx"/></label>
       <label>{t('Arguments (space separated)')}<input value={mcpArgs} onChange={event => setMcpArgs(event.target.value)} placeholder="-y qichacha-mcp"/></label>
      </>
      : <label>{t('Server URL')}<input value={mcpUrl} onChange={event => setMcpUrl(event.target.value)} placeholder="https://example.com/mcp" inputMode="url"/></label>}
     <p className="small">{t('Use absolute command paths: MCP child processes inherit the workspace directory.')}</p>
     <div className="review-actions">
      <button className="primary" type="submit" disabled={busy === 'add-mcp'}><Plus size={15}/>{t('Add server')}</button>
      <button className="secondary" type="button" onClick={resetMcpForm}>{t('Cancel')}</button>
     </div>
    </form>}
    <div className="settings-raw">
     <label>{t('Raw mcp.json (replace the whole file)')}
      <textarea rows={12} value={rawValue} onChange={event => setRawJson(event.target.value)} spellCheck={false} aria-label={t('Raw MCP configuration JSON')}/>
     </label>
     <div className="review-actions">
      <button className="primary" onClick={() => void saveRaw()} disabled={busy === 'raw'}><Save size={16}/>{t('Save raw JSON')}</button>
     </div>
     <p className="small">{t('Saving replaces every MCP server. Each entry needs a command (stdio) or url (http).')}</p>
    </div>
   </>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><BookOpen size={18}/><div><h2>{t('Skills')}</h2><p>{t('Skills add focused instructions to agent sessions.')}</p></div></div>
   {!isAdmin && <p className="small">{canToggle
    ? t('You can enable or disable skills. Only admins can add, edit or remove them.')
    : t('Viewers can read the skill list but cannot change it.')}</p>}
   {skills.length === 0
    ? <p className="small settings-empty">{t('No skills yet.')}</p>
    : <ul className="settings-list">
      {skills.map(skill => <li className="settings-row" key={skill.id}>
       <div className="settings-row-main">
        <strong>{skill.name}</strong>
        <span className="settings-meta">{skill.slug}{skill.description ? ' · ' + skill.description : ''}{skill.enabled ? '' : ' · ' + t('Disabled')}</span>
       </div>
       <div className="settings-row-actions">
        {isAdmin && <button className="secondary" onClick={() => setOpenSkillId(openSkillId === skill.id ? null : skill.id)} aria-expanded={openSkillId === skill.id}>
         {openSkillId === skill.id ? t('Close editor') : t('Edit')}
        </button>}
        {isAdmin && <button className="secondary danger" onClick={() => void removeSkill(skill.id)} disabled={busy === 'del-skill:' + skill.id} aria-label={t('Remove skill {name}', {name: skill.name})}>
         <Trash2 size={14}/>{t('Remove')}
        </button>}
        <label className="settings-switch">
         <input
          type="checkbox"
          checked={skill.enabled}
          onChange={() => void toggleSkill(skill)}
          disabled={!canToggle || busy === 'skill:' + skill.id}
          aria-label={t('Enable skill {name}', {name: skill.name})}
         />
         {t('Enabled')}
        </label>
       </div>
       {isAdmin && openSkillId === skill.id && <div className="settings-editor">
        <div className="settings-grid">
         <label>{t('Name')}<input value={draftFor(skill).name} onChange={event => updateDraft(skill.id, {name: event.target.value})}/></label>
         <label>{t('Description')}<input value={draftFor(skill).description} onChange={event => updateDraft(skill.id, {description: event.target.value})}/></label>
        </div>
        <label>{t('Skill content')}<textarea rows={8} value={draftFor(skill).content} onChange={event => updateDraft(skill.id, {content: event.target.value})} spellCheck={false}/></label>
        <div className="review-actions">
         <button className="primary" onClick={() => void saveSkill(skill.id)} disabled={busy === 'skill:' + skill.id}><Save size={15}/>{t('Save skill')}</button>
         <button className="secondary" onClick={() => setOpenSkillId(null)}>{t('Cancel')}</button>
        </div>
       </div>}
      </li>)}
     </ul>}

   {isAdmin && <>
    <div className="review-actions">
     <button className="secondary" onClick={() => setShowSkillForm(!showSkillForm)}><Plus size={15}/>{showSkillForm ? t('Close form') : t('Add skill')}</button>
    </div>
    {showSkillForm && <form className="settings-editor" onSubmit={event => void submitSkill(event)}>
     <div className="settings-grid">
      <label>{t('Name')}<input value={skillName} onChange={event => setSkillName(event.target.value)} placeholder={t('e.g. Trade show checklist')}/></label>
      <label>{t('Description')}<input value={skillDescription} onChange={event => setSkillDescription(event.target.value)}/></label>
     </div>
     <label>{t('Skill content')}<textarea rows={6} value={skillContent} onChange={event => setSkillContent(event.target.value)} placeholder={t('Instructions the agent should follow')} spellCheck={false}/></label>
     <div className="review-actions">
      <button className="primary" type="submit" disabled={busy === 'add-skill'}><Plus size={15}/>{t('Add skill')}</button>
      <button className="secondary" type="button" onClick={() => setShowSkillForm(false)}>{t('Cancel')}</button>
     </div>
    </form>}
   </>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><Puzzle size={18}/><div><h2>{t('Plugins')}</h2><p>{t('Plugins are Pi extensions loaded into agent sessions. Only admins can install or remove them.')}</p></div></div>
   {!isAdmin && <p className="small">{canToggle
    ? t('You can enable or disable plugins. Only admins can add or remove them.')
    : t('Viewers can read the plugin list but cannot change it.')}</p>}
   {plugins.length === 0
    ? <p className="small settings-empty">{t('No plugins installed yet.')}</p>
    : <ul className="settings-list">
      {plugins.map(plugin => <li className="settings-row" key={plugin.id}>
       <div className="settings-row-main">
        <strong>{plugin.name}</strong>
        <span className="settings-meta">{plugin.slug}{plugin.file ? ' · ' + plugin.file : ''}{plugin.enabled ? '' : ' · ' + t('Disabled')}</span>
       </div>
       <div className="settings-row-actions">
        {isAdmin && <button className="secondary danger" onClick={() => void removePlugin(plugin.id)} disabled={busy === 'del-plugin:' + plugin.id} aria-label={t('Remove plugin {name}', {name: plugin.name})}>
         <Trash2 size={14}/>{t('Remove')}
        </button>}
        <label className="settings-switch">
         <input
          type="checkbox"
          checked={plugin.enabled}
          onChange={() => void togglePlugin(plugin)}
          disabled={!canToggle || busy === 'plugin:' + plugin.id}
          aria-label={t('Enable plugin {name}', {name: plugin.name})}
         />
         {t('Enabled')}
        </label>
       </div>
      </li>)}
     </ul>}

   {isAdmin && <>
    <div className="review-actions">
     <button className="secondary" onClick={() => setShowPluginForm(!showPluginForm)}><Plus size={15}/>{showPluginForm ? t('Close form') : t('Add plugin')}</button>
    </div>
    {showPluginForm && <form className="settings-editor" onSubmit={event => void submitPlugin(event)}>
     <label>{t('Plugin name')}<input value={pluginName} onChange={event => setPluginName(event.target.value)} placeholder={t('e.g. Event notes formatter')}/></label>
     <label>{t('Plugin code')}<textarea rows={8} value={pluginContent} onChange={event => setPluginContent(event.target.value)} spellCheck={false} placeholder="export default function() {}"/></label>
     <div className="review-actions">
      <button className="primary" type="submit" disabled={busy === 'add-plugin'}><Plus size={15}/>{t('Add plugin')}</button>
      <button className="secondary" type="button" onClick={() => setShowPluginForm(false)}>{t('Cancel')}</button>
     </div>
    </form>}
   </>}
  </section>

  <section className="panel padded">
   <div className="settings-section-head"><Wrench size={18}/><div><h2>{t('Recipes')}</h2><p>{t('Recipes are approved extraction rules for sites that need more than the generic collector.')}</p></div></div>
   {!isAdmin && <p className="small">{t('Viewers and users can read recipes. Approving or disabling them needs the admin role.')}</p>}
   {recipesError && <div role="alert" className="alert error"><AlertCircle size={16}/><span>{t(recipesError)}</span><button className="secondary" onClick={() => void loadRecipes()}>{t('Retry')}</button></div>}
   {recipesLoading && recipes.length === 0 && <p className="small settings-empty"><LoaderCircle className="spin" size={15}/> {t('Loading recipes…')}</p>}
   {!recipesLoading && !recipesError && recipes.length === 0 && <p className="small settings-empty">{t('No recipes proposed yet.')}</p>}
   {recipes.length > 0 && <div className="table-wrap">
    <table className="settings-table">
     <thead><tr><th>{t('DOMAIN')}</th><th>{t('KIND')}</th><th>{t('VERSION')}</th><th>{t('STATUS')}</th>{isAdmin && <th>{t('ACTIONS')}</th>}</tr></thead>
     <tbody>
      {recipes.map(recipe => <tr key={recipe.id}>
       <td><strong>{recipe.domain}</strong>{recipe.notes && <small>{recipe.notes}</small>}</td>
       <td>{recipe.kind}</td>
       <td>v{recipe.version}</td>
       <td><span className={'badge recipe-' + recipe.status}>{t(recipeLabelKey(recipe.status))}</span></td>
       {isAdmin && <td className="settings-recipe-actions">
        {recipe.status !== 'approved' && <button className="secondary" onClick={() => void setRecipeStatus(recipe, 'approved')} disabled={busy === 'recipe:' + recipe.id}><Check size={14}/>{t('Approve')}</button>}
        {recipe.status !== 'disabled' && <button className="secondary danger" onClick={() => void setRecipeStatus(recipe, 'disabled')} disabled={busy === 'recipe:' + recipe.id}><X size={14}/>{t('Disable')}</button>}
       </td>}
      </tr>)}
     </tbody>
    </table>
   </div>}
  </section>
 </div>;
}

// Event-first landing page (M3c): filter the trade-show library, browse it as a
// list or a timeline, read a verifiable detail panel and queue discover/enrich
// tasks. Only src/api.ts is used for data access so error text comes from the
// backend unchanged (a role failure shows its "Requires user role" message).
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {
 AlertCircle, Building2, CalendarDays, Check, ExternalLink, FileJson, FileSpreadsheet,
 LayoutList, LoaderCircle, MapPin, Pencil, Plus, RefreshCw, Search, X,
} from 'lucide-react';
import {discoverEvents, enrichEvent, exportEvents, getEvent, listEvents, patchEvent} from './api';
import type {EventFilter} from './api';
import {locale, useI18n} from './i18n';
import type {Lang} from './i18n';
import type {Availability, Confidence, EventExportFormat, EventStatus, MarketEvent, Role} from './types';
import './messages-events';

type RangeKey = '6m' | '12m' | 'all';
type Notice = {text: string; tasks: boolean};

const RANGE_MONTHS: Record<Exclude<RangeKey, 'all'>, number> = {'6m': 6, '12m': 12};
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Fields used to estimate how much of an event record has been sourced. Keeping
// the list explicit makes the bar comparable between records and intentional.
const COMPLETENESS_FIELDS: ((event: MarketEvent) => unknown)[] = [
 event => event.name,
 event => event.startDate,
 event => event.endDate,
 event => event.city,
 event => event.venue,
 event => event.organizer,
 event => event.website,
 event => event.industries.length,
 event => event.scope,
 event => event.applicationDeadline,
 event => event.boothPrice,
 event => event.exhibitorCount,
 event => event.exhibitorListUrl,
 event => event.sources.length,
];

function completeness(event: MarketEvent) {
 const filled = COMPLETENESS_FIELDS.filter(field => Boolean(field(event))).length;
 return Math.round((filled / COMPLETENESS_FIELDS.length) * 100);
}

function competitorCounts(event: MarketEvent) {
 const total = event.competitors.length;
 const confirmed = event.competitors.filter(item => item.participating === true).length;
 return {confirmed, total};
}

function isoDay(date: Date) {
 const month = String(date.getMonth() + 1).padStart(2, '0');
 const day = String(date.getDate()).padStart(2, '0');
 return date.getFullYear() + '-' + month + '-' + day;
}

function addMonths(date: Date, months: number) {
 const next = new Date(date);
 next.setMonth(next.getMonth() + months);
 return next;
}

function parseDay(value: string) {
 const parsed = new Date(value + 'T00:00:00');
 return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDay(value: string, lang: Lang) {
 const parsed = parseDay(value);
 if (!parsed) return value;
 return parsed.toLocaleDateString(locale(lang), {day: 'numeric', month: 'short', year: 'numeric'});
}

function formatDateTime(value: string, lang: Lang) {
 const parsed = new Date(value);
 if (Number.isNaN(parsed.getTime())) return value;
 return parsed.toLocaleString(locale(lang), {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'});
}

// URLs come from scraped pages, so only http(s) links become clickable anchors.
function safeHttpUrl(value: string) {
 try {
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
 } catch {
  return '';
 }
}

function hasDate(value: string | null): value is string {
 return Boolean(value && DATE_PATTERN.test(value));
}

function StatusBadge({status}: {status: EventStatus}) {
 const {t} = useI18n();
 const labels: Record<EventStatus, string> = {discovered: 'Discovered', enriched: 'Enriched', verified: 'Verified', archived: 'Archived'};
 return <span className={'badge ev-badge ' + status}>{t(labels[status] ?? status)}</span>;
}

function ConfidenceBadge({confidence}: {confidence: Confidence}) {
 const {t} = useI18n();
 const labels: Record<Confidence, string> = {high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence'};
 return <span className={'badge ev-badge confidence-' + confidence}>{t(labels[confidence] ?? confidence)}</span>;
}

function AvailabilityBadge({availability}: {availability: Availability}) {
 const {t} = useI18n();
 const labels: Record<Availability, string> = {linked: 'Linked', downloadable: 'Downloadable', restricted: 'Restricted', unknown: 'Unknown'};
 return <span className={'badge ev-availability ' + availability}>{t(labels[availability] ?? availability)}</span>;
}

function EventCard({event, active, onSelect}: {event: MarketEvent; active: boolean; onSelect: (event: MarketEvent) => void}) {
 const {t, lang} = useI18n();
 const value = completeness(event);
 const {confirmed, total} = competitorCounts(event);
 return <button
  type="button"
  className={'ev-card' + (active ? ' active' : '')}
  onClick={() => onSelect(event)}
  aria-pressed={active}
  aria-label={t('Open event details for {name}', {name: event.name})}
 >
  <span className="ev-card-top">
   <span className="ev-card-date">
    {hasDate(event.startDate)
     ? <>{formatDay(event.startDate!, lang)}{event.endDate && hasDate(event.endDate) && <small> – {formatDay(event.endDate, lang)}</small>}</>
     : <span className="ev-date-pending"><AlertCircle size={13}/>{t('Date to be confirmed')}</span>}
   </span>
   <span className="ev-card-badges"><StatusBadge status={event.status}/><ConfidenceBadge confidence={event.confidence}/></span>
  </span>
  <span className="ev-card-title">{event.name || t('Untitled event')}</span>
  <span className="ev-card-meta">
   <span><MapPin size={13}/>{[event.city, event.country].filter(Boolean).join(', ') || t('Location to be confirmed')}</span>
   <span><Building2 size={13}/>{event.venue || t('Venue to be confirmed')}</span>
  </span>
  <span className="ev-card-foot">
   <span className="ev-completeness">
    <span className="ev-completeness-head"><span>{t('Data completeness')}</span><strong>{value}%</strong></span>
    <span className="ev-progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={t('Data completeness')}>
     <span style={{width: value + '%'}}/>
    </span>
   </span>
   <span className="ev-competitors">
    <span>{t('Competitors at the show')}</span>
    <strong>{total ? t('{confirmed} of {total}', {confirmed, total}) : '—'}</strong>
   </span>
  </span>
 </button>;
}

function DetailField({label, children}: {label: string; children: ReactNode}) {
 return <div className="ev-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

function ExternalTextLink({url, children}: {url: string; children?: ReactNode}) {
 const href = safeHttpUrl(url);
 if (!href) return <span className="ev-empty-value">{url || '—'}</span>;
 return <a href={href} target="_blank" rel="noreferrer noopener">{children ?? url} <ExternalLink size={12}/></a>;
}

type EditDraft = {
 name: string;
 startDate: string;
 endDate: string;
 city: string;
 province: string;
 district: string;
 venue: string;
 website: string;
 applicationDeadline: string;
 boothPrice: string;
 ticketPrice: string;
 exhibitorListUrl: string;
 notes: string;
};

function toDraft(event: MarketEvent): EditDraft {
 return {
  name: event.name,
  startDate: event.startDate ?? '',
  endDate: event.endDate ?? '',
  city: event.city,
  province: event.province,
  district: event.district,
  venue: event.venue,
  website: event.website,
  applicationDeadline: event.applicationDeadline ?? '',
  boothPrice: event.boothPrice,
  ticketPrice: event.ticketPrice,
  exhibitorListUrl: event.exhibitorListUrl,
  notes: event.notes.join('\n'),
 };
}

function validateDraft(draft: EditDraft): string {
 if (!draft.name.trim()) return 'Event name is required.';
 const dated = [
  ['Start date', draft.startDate],
  ['End date', draft.endDate],
  ['Application deadline', draft.applicationDeadline],
 ] as const;
 for (const [, value] of dated) {
  if (value && !DATE_PATTERN.test(value)) return 'Use YYYY-MM-DD for dates.';
 }
 if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) return 'End date must be after the start date.';
 return '';
}

function draftChanges(event: MarketEvent, draft: EditDraft): Partial<MarketEvent> {
 const changes: Partial<MarketEvent> = {};
 const name = draft.name.trim();
 if (name !== event.name) changes.name = name;
 const startDate = draft.startDate || null;
 if (startDate !== event.startDate) changes.startDate = startDate;
 const endDate = draft.endDate || null;
 if (endDate !== event.endDate) changes.endDate = endDate;
 const applicationDeadline = draft.applicationDeadline || null;
 if (applicationDeadline !== event.applicationDeadline) changes.applicationDeadline = applicationDeadline;
 if (draft.city.trim() !== event.city) changes.city = draft.city.trim();
 if (draft.province.trim() !== event.province) changes.province = draft.province.trim();
 if (draft.district.trim() !== event.district) changes.district = draft.district.trim();
 if (draft.venue.trim() !== event.venue) changes.venue = draft.venue.trim();
 if (draft.website.trim() !== event.website) changes.website = draft.website.trim();
 if (draft.boothPrice.trim() !== event.boothPrice) changes.boothPrice = draft.boothPrice.trim();
 if (draft.ticketPrice.trim() !== event.ticketPrice) changes.ticketPrice = draft.ticketPrice.trim();
 if (draft.exhibitorListUrl.trim() !== event.exhibitorListUrl) changes.exhibitorListUrl = draft.exhibitorListUrl.trim();
 const notes = draft.notes.split('\n').map(line => line.trim()).filter(Boolean);
 if (JSON.stringify(notes) !== JSON.stringify(event.notes)) changes.notes = notes;
 return changes;
}

function EventDetail({event, canWrite, enriching, patching, onClose, onEnrich, onPatch}: {
 event: MarketEvent;
 canWrite: boolean;
 enriching: boolean;
 patching: boolean;
 onClose: () => void;
 onEnrich: (event: MarketEvent) => void;
 onPatch: (changes: Partial<MarketEvent>) => Promise<boolean>;
}) {
 const {t, lang} = useI18n();
 const [editing, setEditing] = useState(false);
 const [draft, setDraft] = useState<EditDraft>(() => toDraft(event));
 const [formError, setFormError] = useState('');

 // Selecting another event must never keep the previous event's edit form.
 useEffect(() => {
  setEditing(false);
  setFormError('');
  setDraft(toDraft(event));
 }, [event.id]);

 // A refresh of the selected record (enrich task finished, filters reloaded)
 // must not silently discard an open edit form.
 useEffect(() => {
  if (!editing) setDraft(toDraft(event));
 }, [event, editing]);

 const {confirmed, total} = competitorCounts(event);
 const value = completeness(event);
 const dated = hasDate(event.startDate);
 const notes = [...event.notes];

 function update<K extends keyof EditDraft>(key: K, value: EditDraft[K]) {
  setDraft(previous => ({...previous, [key]: value}));
 }

 async function save() {
  const validation = validateDraft(draft);
  if (validation) { setFormError(t(validation)); return; }
  const changes = draftChanges(event, draft);
  if (!Object.keys(changes).length) { setFormError(t('No changes to save.')); return; }
  setFormError('');
  const saved = await onPatch(changes);
  if (saved) setEditing(false);
 }

 return <aside className="panel ev-detail" id="event-detail" aria-label={t('Event details')}>
  <div className="ev-detail-head">
   <div>
    <span className="eyebrow">{t('EVENT PROFILE')}</span>
    <h2>{event.name || t('Untitled event')}</h2>
    <p className="small ev-detail-sub">{[event.city, event.country, event.venue].filter(Boolean).join(' · ') || t('Location to be confirmed')}</p>
   </div>
   <button className="ev-icon-btn" aria-label={t('Close event details')} onClick={onClose}><X size={17}/></button>
  </div>

  <div className="ev-detail-badges">
   <StatusBadge status={event.status}/>
   <ConfidenceBadge confidence={event.confidence}/>
   <span className="badge ev-badge region">{t(event.region === 'cn' ? 'China' : event.region === 'eu' ? 'Europe' : 'Global')}</span>
   <span className="badge ev-badge completeness">{t('{value}% complete', {value})}</span>
  </div>

  {canWrite && !editing && <div className="ev-detail-actions">
   <button className="secondary" onClick={() => onEnrich(event)} disabled={enriching}>
    {enriching ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}
    {enriching ? t('Queuing enrichment…') : t('Enrich details')}
   </button>
   <button className="secondary" onClick={() => { setDraft(toDraft(event)); setFormError(''); setEditing(true); }} disabled={patching}>
    <Pencil size={15}/>{t('Edit details')}
   </button>
  </div>}

  {!dated && <div className="ev-warning"><AlertCircle size={15}/><span>{t('Dates are not confirmed yet. Check the official website before planning.')}</span></div>}

  {editing
   ? <form className="ev-edit-form" onSubmit={submit => { submit.preventDefault(); void save(); }}>
     {formError && <div role="alert" className="alert error">{formError}</div>}
     <label>{t('Event name')}<input value={draft.name} onChange={event => update('name', event.target.value)} maxLength={200}/></label>
     <div className="ev-form-two">
      <label>{t('Start date')}<input type="date" value={draft.startDate} onChange={event => update('startDate', event.target.value)}/></label>
      <label>{t('End date')}<input type="date" value={draft.endDate} onChange={event => update('endDate', event.target.value)}/></label>
     </div>
     <div className="ev-form-two">
      <label>{t('City')}<input value={draft.city} onChange={event => update('city', event.target.value)} maxLength={120}/></label>
      <label>{t('Province')}<input value={draft.province} onChange={event => update('province', event.target.value)} maxLength={120}/></label>
     </div>
     <div className="ev-form-two">
      <label>{t('District / county')}<input value={draft.district} onChange={event => update('district', event.target.value)} maxLength={120}/></label>
      <label>{t('Venue')}<input value={draft.venue} onChange={event => update('venue', event.target.value)} maxLength={200}/></label>
     </div>
     <label>{t('Official website')}<input value={draft.website} onChange={event => update('website', event.target.value)} placeholder="https://" inputMode="url"/></label>
     <div className="ev-form-two">
      <label>{t('Application deadline')}<input type="date" value={draft.applicationDeadline} onChange={event => update('applicationDeadline', event.target.value)}/></label>
      <label>{t('Booth price')}<input value={draft.boothPrice} onChange={event => update('boothPrice', event.target.value)}/></label>
     </div>
     <div className="ev-form-two">
      <label>{t('Ticket price')}<input value={draft.ticketPrice} onChange={event => update('ticketPrice', event.target.value)}/></label>
      <label>{t('Exhibitor list URL')}<input value={draft.exhibitorListUrl} onChange={event => update('exhibitorListUrl', event.target.value)} placeholder="https://" inputMode="url"/></label>
     </div>
     <label>{t('Missing data notes')}<textarea rows={4} value={draft.notes} onChange={event => update('notes', event.target.value)} placeholder={t('One note per line')}/></label>
     <div className="ev-detail-actions">
      <button className="primary" type="submit" disabled={patching}>
       {patching ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>}
       {patching ? t('Saving…') : t('Save changes')}
      </button>
      <button className="secondary" type="button" onClick={() => { setEditing(false); setFormError(''); }} disabled={patching}>{t('Cancel')}</button>
     </div>
    </form>
   : <div className="ev-detail-body">
     <dl className="ev-fields">
      <DetailField label={t('Dates')}>
       {dated ? formatDay(event.startDate!, lang) : <span className="ev-empty-value">{t('To be confirmed')}</span>}
       {hasDate(event.endDate) && <span className="ev-inline"> – {formatDay(event.endDate, lang)}</span>}
      </DetailField>
      <DetailField label={t('Application deadline')}>
       {hasDate(event.applicationDeadline)
        ? formatDay(event.applicationDeadline!, lang)
        : <span className="ev-empty-value">{t('To be confirmed')}</span>}
      </DetailField>
      <DetailField label={t('Country')}>{event.country || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Province')}>{event.province || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('City')}>{event.city || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('District / county')}>{event.district || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Venue')}>{event.venue || <span className="ev-empty-value">{t('To be confirmed')}</span>}</DetailField>
      <DetailField label={t('Organizer')}>{event.organizer || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Edition')}>{event.edition !== null ? event.edition : <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Frequency')}>{event.frequency || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Official website')}>
       {event.website ? <ExternalTextLink url={event.website}/> : <span className="ev-empty-value">—</span>}
      </DetailField>
      <DetailField label={t('Industries')}>
       {event.industries.length
        ? <span className="chips">{event.industries.map(industry => <span key={industry}>{industry}</span>)}</span>
        : <span className="ev-empty-value">—</span>}
      </DetailField>
      <DetailField label={t('Scope')}>{event.scope || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Last edition scale')}>
       <span className="ev-scale">
        <span>{t('{value} exhibitors', {value: event.exhibitorCount ?? '—'})}</span>
        <span>{t('{value} visitors', {value: event.visitorCount ?? '—'})}</span>
        <span>{t('{value} area', {value: event.area || '—'})}</span>
       </span>
      </DetailField>
      <DetailField label={t('Exhibitor list')}>
       {event.exhibitorListUrl
        ? <><ExternalTextLink url={event.exhibitorListUrl}>{t('Open exhibitor list')}</ExternalTextLink> <AvailabilityBadge availability={event.exhibitorListStatus}/></>
        : <span className="ev-empty-value">{t('Not available')}</span>}
      </DetailField>
      <DetailField label={t('Booth price')}>{event.boothPrice || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Ticket price')}>{event.ticketPrice || <span className="ev-empty-value">—</span>}</DetailField>
      <DetailField label={t('Competitors at the show')}>
       {total
        ? <span className="ev-inline">{t('{confirmed} of {total} confirmed', {confirmed, total})}</span>
        : <span className="ev-empty-value">{t('No competitor records')}</span>}
      </DetailField>
     </dl>

     {event.competitors.length > 0 && <section className="ev-subsection">
      <h3>{t('Competitor participation')}</h3>
      <ul className="ev-competitors-list">
       {event.competitors.map(competitor => <li key={competitor.name + (competitor.booth ?? '')}>
        <strong>{competitor.name}</strong>
        <span className={'badge ev-badge ' + (competitor.participating === true ? 'verified' : competitor.participating === false ? 'archived' : 'confidence-low')}>
         {competitor.participating === true ? t('Participating') : competitor.participating === false ? t('Not participating') : t('Unknown')}
        </span>
        {competitor.booth && <span className="ev-muted">{t('Booth {booth}', {booth: competitor.booth})}</span>}
        {competitor.sourceUrl && <ExternalTextLink url={competitor.sourceUrl}>{competitor.sourceUrl}</ExternalTextLink>}
       </li>)}
      </ul>
     </section>}

     {event.documents.length > 0 && <section className="ev-subsection">
      <h3>{t('Documents')}</h3>
      <ul className="ev-documents">
       {event.documents.map(document => <li key={document.url}>
        <ExternalTextLink url={document.url}>{document.title || t('Open document')}</ExternalTextLink>
        <span className="ev-doc-url">{document.url}</span>
        <span className="ev-doc-meta">
         <span className="badge ev-badge doc-type">{document.type || t('File')}</span>
         <AvailabilityBadge availability={document.status}/>
         {document.parseProvider && <span className="ev-muted">{document.parseProvider}{document.parsedAt ? ' · ' + formatDateTime(document.parsedAt, lang) : ''}</span>}
        </span>
       </li>)}
      </ul>
     </section>}

     {notes.length > 0 && <section className="ev-subsection">
      <h3>{t('Missing data notes')}</h3>
      <ul className="ev-notes">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
     </section>}

     <section className="ev-subsection">
      <h3>{t('Verified sources')}</h3>
      {event.sources.length
       ? <ul className="ev-sources">
         {event.sources.map(source => <li key={source.url + source.verifiedAt}>
          <ExternalTextLink url={source.url}>{source.title || source.url}</ExternalTextLink>
          <span className="ev-source-url">{source.url}</span>
          <span className="ev-muted">{t('Verified {date}', {date: formatDateTime(source.verifiedAt, lang)})}</span>
         </li>)}
        </ul>
       : <p className="small ev-empty-value">{t('No verified sources yet. Enrich this event to collect them.')}</p>}
     </section>

     <p className="small ev-detail-meta">
      {t('Created {date}', {date: formatDateTime(event.createdAt, lang)})} · {t('Updated {date}', {date: formatDateTime(event.updatedAt, lang)})} · ID {event.id}
     </p>
    </div>}
 </aside>;
}

export default function Events({role, onOpenTasks, onOpenEvent}: {role: Role; onOpenTasks: () => void; onOpenEvent?: (id: string) => void}) {
 const {t, lang} = useI18n();
 const canWrite = role !== 'viewer';

 const [region, setRegion] = useState('cn');
 const [range, setRange] = useState<RangeKey>('12m');
 const [status, setStatus] = useState('all');
 const [qInput, setQInput] = useState('');
 const [q, setQ] = useState('');
 const [view, setView] = useState<'list' | 'timeline'>('list');

 const [events, setEvents] = useState<MarketEvent[] | null>(null);
 const [loading, setLoading] = useState(true);
 const [loadError, setLoadError] = useState('');

 const [selectedId, setSelectedId] = useState<string | null>(null);
 const [detail, setDetail] = useState<MarketEvent | null>(null);
 const [detailError, setDetailError] = useState('');

 const [busy, setBusy] = useState(''); // 'discover' | 'enrich' | 'patch'
 const [exporting, setExporting] = useState<EventExportFormat | ''>('');
 const [error, setError] = useState('');
 const [notice, setNotice] = useState<Notice | null>(null);

 const requestTicket = useRef(0);
 const selectedRef = useRef<string | null>(null);
 selectedRef.current = selectedId;

 // Only region/status/keyword are server filters. The date range is applied on
 // the client because event-store.list() drops records with startDate=null when
 // from/to are present, and undated records must stay visible for enrichment.
 const filter = useMemo<EventFilter>(() => {
  const next: EventFilter = {};
  if (region) next.region = region;
  if (status !== 'all') next.status = status;
  if (q.trim()) next.q = q.trim();
  return next;
 }, [region, status, q]);

 const rangeWindow = useMemo(() => {
  if (range === 'all') return null;
  const now = new Date();
  return {from: isoDay(now), to: isoDay(addMonths(now, RANGE_MONTHS[range]))};
 }, [range]);

 const load = useCallback(async () => {
  const ticket = ++requestTicket.current;
  setLoading(true);
  setLoadError('');
  try {
   const payload = await listEvents(filter);
   if (ticket !== requestTicket.current) return;
   setEvents(payload.events);
   // Keep the open detail in sync without dropping records outside the filter.
   setDetail(previous => previous ? payload.events.find(item => item.id === previous.id) ?? previous : previous);
  } catch (cause) {
   if (ticket !== requestTicket.current) return;
   setEvents([]);
   setDetail(null);
   setSelectedId(null);
   setLoadError(cause instanceof Error ? cause.message : String(cause));
  } finally {
   if (ticket === requestTicket.current) setLoading(false);
  }
 }, [filter]);

 useEffect(() => { void load(); }, [load]);

 // Typing should not fire one request per keystroke.
 useEffect(() => {
  const timer = window.setTimeout(() => setQ(qInput), 300);
  return () => window.clearTimeout(timer);
 }, [qInput]);

 const trimmed = useMemo(() => events ?? [], [events]);

 // Records without a confirmed date are never hidden by the date range: the
 // product requires "date to be confirmed" events to stay visible so they can
 // be enriched or corrected. event-store.list() would drop them when from/to
 // are passed, which is why the range is filtered here instead.
 const visible = useMemo(() => {
  if (!rangeWindow) return trimmed;
  return trimmed.filter(event => {
   const start = event.startDate;
   if (!start || !hasDate(start)) return true;
   return start >= rangeWindow.from && start <= rangeWindow.to;
  });
 }, [trimmed, rangeWindow]);

 const sorted = useMemo(() => [...visible].sort((left, right) =>
  (left.startDate ?? '9999-99-99').localeCompare(right.startDate ?? '9999-99-99') || left.name.localeCompare(right.name)),
 [visible]);

 const groups = useMemo(() => {
  const buckets = new Map<string, MarketEvent[]>();
  for (const event of sorted) {
   const key = hasDate(event.startDate) ? event.startDate!.slice(0, 7) : 'undated';
   const bucket = buckets.get(key);
   if (bucket) bucket.push(event);
   else buckets.set(key, [event]);
  }
  return [...buckets.entries()]
   .sort(([left], [right]) => {
    if (left === 'undated') return 1;
    if (right === 'undated') return -1;
    return left.localeCompare(right);
   })
   .map(([key, groupEvents]) => ({
    key,
    label: key === 'undated' ? t('Date to be confirmed') : parseDay(key + '-01')?.toLocaleDateString(locale(lang), {year: 'numeric', month: 'long'}) ?? key,
    events: groupEvents,
   }));
 }, [sorted, lang, t]);

 function openDetail(event: MarketEvent) {
  setSelectedId(event.id);
  setDetail(event);
  setDetailError('');
  onOpenEvent?.(event.id);
  if (window.matchMedia('(max-width: 900px)').matches) {
   window.setTimeout(() => document.getElementById('event-detail')?.scrollIntoView({behavior: 'smooth', block: 'start'}), 30);
  }
  // The list payload is already complete; refetching keeps a long-open panel
  // current after an enrich task ran in another tab.
  void getEvent(event.id).then(fresh => {
   if (selectedRef.current !== fresh.id) return;
   setDetail(fresh);
   setEvents(previous => previous ? previous.map(item => item.id === fresh.id ? fresh : item) : previous);
  }).catch(cause => {
   if (selectedRef.current !== event.id) return;
   setDetailError(cause instanceof Error ? cause.message : String(cause));
  });
 }

 async function handleDiscover() {
  setBusy('discover');
  setError('');
  setNotice(null);
  try {
   await discoverEvents({region: region || 'cn'});
   setNotice({text: t('Discovery task queued. Track progress on the tasks page.'), tasks: true});
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
   setBusy('');
  }
 }

 async function handleEnrich(event: MarketEvent) {
  setBusy('enrich');
  setError('');
  setNotice(null);
  try {
   await enrichEvent(event.id);
   setNotice({text: t('Enrichment task queued for {name}.', {name: event.name}), tasks: true});
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
   setBusy('');
  }
 }

 async function handlePatch(id: string, changes: Partial<MarketEvent>): Promise<boolean> {
  setBusy('patch');
  setError('');
  setNotice(null);
  try {
   const updated = await patchEvent(id, changes);
   setDetail(previous => previous && previous.id === id ? updated : previous);
   setEvents(previous => previous ? previous.map(item => item.id === id ? updated : item) : previous);
   setNotice({text: t('Event details saved.'), tasks: false});
   return true;
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : String(cause));
   return false;
  } finally {
   setBusy('');
  }
 }

 async function handleExport(format: EventExportFormat) {
  setExporting(format);
  setError('');
  try {
   await exportEvents(format);
   setNotice({text: t('{format} export downloaded.', {format: format.toUpperCase()}), tasks: false});
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
   setExporting('');
  }
 }

 const activeId = selectedId;
 const showEmpty = !loading && !loadError && sorted.length === 0;
 const libraryEmpty = trimmed.length === 0;
 const searchFiltersActive = Boolean(q.trim()) || region !== 'cn' || status !== 'all';
 const noEventsAtAll = libraryEmpty && !searchFiltersActive;

 return <div className="events-page">
  <div className="page-heading">
   <div>
    <div className="eyebrow">{t('EVENT-FIRST INTELLIGENCE')}</div>
    <h1>{t('Event calendar')}</h1>
    <p>{t('Verified trade shows, dates and application details for planning the next 12 months.')}</p>
   </div>
   <div className="ev-heading-actions">
    {canWrite && <button className="primary" onClick={() => void handleDiscover()} disabled={busy === 'discover'}>
     {busy === 'discover' ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>}
     {busy === 'discover' ? t('Discovering…') : t('Discover events')}
    </button>}
    <button className="secondary" onClick={() => void handleExport('csv')} disabled={exporting !== ''}>
     {exporting === 'csv' ? <LoaderCircle className="spin" size={16}/> : <FileSpreadsheet size={16}/>} {t('Export CSV')}
    </button>
    <button className="secondary" onClick={() => void handleExport('json')} disabled={exporting !== ''}>
     {exporting === 'json' ? <LoaderCircle className="spin" size={16}/> : <FileJson size={16}/>} {t('Export JSON')}
    </button>
   </div>
  </div>

  {error && <div role="alert" className="alert error">
   <AlertCircle size={18}/><span>{t(error)}</span>
   <button aria-label={t('Dismiss error')} onClick={() => setError('')}><X size={16}/></button>
  </div>}
  {notice && <div role="status" className="alert success">
   <Check size={17}/><span>{notice.text}</span>
   {notice.tasks && <button className="secondary ev-notice-action" onClick={onOpenTasks}>{t('Open tasks')}</button>}
  </div>}

  <section className="panel ev-toolbar-panel">
   <div className="ev-toolbar">
    <div className="search-field ev-search">
     <Search size={16}/>
     <input
      aria-label={t('Search events')}
      placeholder={t('Search by name, city or venue…')}
      value={qInput}
      onChange={event => setQInput(event.target.value)}
     />
    </div>
    <select aria-label={t('Filter region')} value={region} onChange={event => setRegion(event.target.value)}>
     <option value="cn">{t('China')}</option>
     <option value="eu">{t('Europe')}</option>
     <option value="global">{t('Global')}</option>
     <option value="">{t('All regions')}</option>
    </select>
    <select aria-label={t('Filter date range')} value={range} onChange={event => setRange(event.target.value as RangeKey)}>
     <option value="6m">{t('Next 6 months')}</option>
     <option value="12m">{t('Next 12 months')}</option>
     <option value="all">{t('All time')}</option>
    </select>
    <select aria-label={t('Filter event status')} value={status} onChange={event => setStatus(event.target.value)}>
     <option value="all">{t('All statuses')}</option>
     <option value="discovered">{t('Discovered')}</option>
     <option value="enriched">{t('Enriched')}</option>
     <option value="verified">{t('Verified')}</option>
     <option value="archived">{t('Archived')}</option>
    </select>
    <div className="segmented" role="group" aria-label={t('View mode')}>
     <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
      <LayoutList size={14}/>{t('List')}
     </button>
     <button type="button" className={view === 'timeline' ? 'active' : ''} onClick={() => setView('timeline')}>
      <CalendarDays size={14}/>{t('Timeline')}
     </button>
    </div>
   </div>
   <p className="small ev-count" role="status">
    {loading
     ? t('Loading events…')
     : loadError
      ? t('Events could not be loaded.')
      : t('{count} events match these filters.', {count: sorted.length})}
    {detailError && <span className="ev-inline-error"> {t('The selected event could not be refreshed.')}</span>}
   </p>
  </section>

  <div className={'ev-layout' + (detail ? ' has-detail' : '')}>
   <div className="ev-main">
    {loading && <section className="panel padded ev-loading">
     <LoaderCircle className="spin" size={22}/><span>{t('Loading events…')}</span>
    </section>}

    {!loading && loadError && <section className="panel padded ev-error-state">
     <AlertCircle size={24}/>
     <h2>{t('Events could not be loaded')}</h2>
     <p>{t(loadError)}</p>
     <button className="secondary" onClick={() => void load()}><RefreshCw size={15}/>{t('Retry')}</button>
    </section>}

    {showEmpty && <section className="panel padded ev-empty">
      <CalendarDays size={30}/>
      <h2>{noEventsAtAll ? t('No events in the library yet') : t('No events match these filters')}</h2>
      <p>{noEventsAtAll
       ? canWrite
        ? t('Start by discovering trade shows from the source registry, then enrich the promising ones.')
        : t('No events have been discovered yet. A user or admin can start a discovery task.')
       : t('Adjust the region, date range, status or search words.')}</p>
      <div className="ev-empty-actions">
       {canWrite && <button className="primary" onClick={() => void handleDiscover()} disabled={busy === 'discover'}>
        {busy === 'discover' ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>} {t('Discover events')}
       </button>}
       {!canWrite && <button className="secondary" onClick={onOpenTasks}>{t('Open tasks')}</button>}
       <button className="secondary" onClick={() => { setQInput(''); setStatus('all'); setRange('all'); setRegion(''); }}>{t('Clear filters')}</button>
      </div>
     </section>}

    {!loading && !loadError && view === 'list' && sorted.length > 0 &&
     <div className="ev-cards">
      {sorted.map(event => <EventCard key={event.id} event={event} active={activeId === event.id} onSelect={openDetail}/>)}
     </div>}

    {!loading && !loadError && view === 'timeline' && sorted.length > 0 &&
     <div className="ev-timeline">
      {groups.map(group => <div className="ev-timeline-group" key={group.key}>
       <div className="ev-timeline-label"><span className="ev-timeline-dot"/>{group.label}</div>
       <div className="ev-timeline-items">
        {group.events.map(event => <EventCard key={event.id} event={event} active={activeId === event.id} onSelect={openDetail}/>)}
       </div>
      </div>)}
     </div>}
   </div>

   {detail && <EventDetail
    event={detail}
    canWrite={canWrite}
    enriching={busy === 'enrich'}
    patching={busy === 'patch'}
    onClose={() => { setSelectedId(null); setDetail(null); setDetailError(''); }}
    onEnrich={event => void handleEnrich(event)}
    onPatch={changes => handlePatch(detail.id, changes)}
   />}
  </div>
 </div>;
}

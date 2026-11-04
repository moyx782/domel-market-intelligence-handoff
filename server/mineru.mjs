// MinerU document parsing — configuration and availability policy.
//
// This phase only defines the integration surface: which provider is configured,
// where it lives, and whether a document is worth sending. Parsing itself is
// enabled later. Policy: show the official link and whether it is obtainable;
// never OCR or download a document just because a page links to it.

const OFFICIAL_BASE = 'https://mineru.net/api/v4';
const LOCAL_BASE = 'http://127.0.0.1:8000';
const FILE_EXTENSIONS = /\.(pdf|docx?|pptx?|xlsx?|csv|ofd|epub|mhtml?|rtf|png|jpe?g|webp|tiff?)$/i;

function normalizeBaseUrl(value, fallback) {
 const raw = String(value ?? '').trim();
 if (!raw) return fallback;
 try {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
 } catch {
  return fallback;
 }
}

export function mineruConfig(env = process.env, overrides = {}) {
 const requested = String(overrides.provider ?? env.MINERU_PROVIDER ?? 'none').toLowerCase();
 const provider = ['official', 'local'].includes(requested) ? requested : 'none';
 const token = overrides.token ?? env.MINERU_API_TOKEN ?? '';
 // Any http(s) host, port and base path is allowed, including an internal
 // deployment such as https://mineru.corp.example/api or http://10.0.0.5:8000.
 const baseUrl = provider === 'official'
  ? normalizeBaseUrl(overrides.officialBase ?? env.MINERU_API_BASE, OFFICIAL_BASE)
  : normalizeBaseUrl(overrides.localUrl ?? env.MINERU_LOCAL_URL, LOCAL_BASE);
 const timeoutMs = Math.max(5000, Number(overrides.timeoutMs ?? env.MINERU_TIMEOUT_MS) || 120000);
 return {
  provider,
  baseUrl,
  token,
  timeoutMs,
  modelVersion: String(overrides.modelVersion ?? env.MINERU_MODEL_VERSION ?? 'vlm'),
  language: String(overrides.language ?? env.MINERU_LANGUAGE ?? 'ch'),
  configured: provider === 'official' ? Boolean(token) : provider === 'local',
 };
}

// Public status: never includes the token.
export function mineruStatus(env = process.env, overrides = {}) {
 const config = mineruConfig(env, overrides);
 return {
  provider: config.provider,
  configured: config.configured,
  baseUrl: config.provider === 'none' ? null : config.baseUrl,
  timeoutMs: config.timeoutMs,
  modelVersion: config.provider === 'none' ? null : config.modelVersion,
  policy: 'ocr-then-agent',
 };
}

// Classify a linked document without downloading it.
// downloadable: a direct file URL; linked: an HTML page that may contain documents;
// restricted/unknown are set by the caller after checking the page.
export function documentAvailability(url) {
 try {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'unknown';
  return FILE_EXTENSIONS.test(parsed.pathname) ? 'downloadable' : 'linked';
 } catch {
  return 'unknown';
}
}

// Real MinerU Standard API parsing (token from Settings or env).
export {parseMineru as parseDocument} from './mineru-client.mjs';

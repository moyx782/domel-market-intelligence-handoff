// Serve the built frontend from the API process so one service covers UI + API.
// Intended for a trusted network: no reverse proxy required.

import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, resolve, sep} from 'node:path';

const TYPES = {
 '.html': 'text/html; charset=utf-8',
 '.js': 'text/javascript; charset=utf-8',
 '.mjs': 'text/javascript; charset=utf-8',
 '.css': 'text/css; charset=utf-8',
 '.json': 'application/json; charset=utf-8',
 '.svg': 'image/svg+xml',
 '.png': 'image/png',
 '.jpg': 'image/jpeg',
 '.jpeg': 'image/jpeg',
 '.webp': 'image/webp',
 '.gif': 'image/gif',
 '.ico': 'image/x-icon',
 '.woff': 'font/woff',
 '.woff2': 'font/woff2',
 '.ttf': 'font/ttf',
 '.txt': 'text/plain; charset=utf-8',
 '.map': 'application/json; charset=utf-8',
};

export function serveStatic(req, res, {root = 'dist'} = {}) {
 if (req.method !== 'GET' && req.method !== 'HEAD') return false;
 const url = new URL(req.url, 'http://localhost');
 if (url.pathname.startsWith('/api/')) return false;
 const base = resolve(root);
 const index = resolve(base, 'index.html');

 let pathname;
 try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
 let file = pathname === '/' ? index : resolve(base, '.' + pathname);
 if (!file.startsWith(base + sep) && file !== index) return false;
 if (!existsSync(file) || !statSync(file).isFile()) file = index;
 if (!existsSync(file)) return false;

 const ext = extname(file).toLowerCase();
 const headers = {
  'Content-Type': TYPES[ext] ?? 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
 };
 const stat = statSync(file);
 headers['Content-Length'] = stat.size;
 res.writeHead(200, headers);
 if (req.method === 'HEAD') return res.end(), true;
 createReadStream(file).pipe(res);
 return true;
}

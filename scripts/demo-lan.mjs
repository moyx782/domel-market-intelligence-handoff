// Start the single-user demo for the local network: API on 0.0.0.0:8788 and
// Vite on 0.0.0.0:5174, with the LAN origins allowed for CORS.
//
// This exposes an unauthenticated demo to everyone on the network. Use it only
// on a trusted LAN and stop it when finished.

import {spawn} from 'node:child_process';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function lanAddresses() {
 const found = [];
 for (const entries of Object.values(networkInterfaces())) {
  for (const entry of entries ?? []) {
   if (entry.family !== 'IPv4' || entry.internal) continue;
   if (PRIVATE.test(entry.address)) found.push(entry.address);
  }
 }
 return [...new Set(found)];
}

const addresses = lanAddresses();
const origins = [
 ...addresses.map(address => `http://${address}:5174`),
 'http://127.0.0.1:5174',
 'http://localhost:5174',
].join(',');

const env = {
 ...process.env,
 LOCAL_API_BIND: '0.0.0.0',
 APP_ORIGINS: origins,
};

const children = [
 spawn(process.execPath, [
  '--env-file-if-exists=.env',
  '--env-file-if-exists=.env.host',
  'server/local-api.mjs',
 ], {stdio: 'inherit', env}),
 spawn(process.execPath, [
  join('node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '0.0.0.0', '--port', '5174',
 ], {stdio: 'inherit', env}),
];

let stopping = false;
function stop(code = 0) {
 if (stopping) return;
 stopping = true;
 for (const child of children) child.kill('SIGTERM');
 setTimeout(() => process.exit(code), 200).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
for (const child of children) child.on('exit', code => { if (!stopping) stop(code ?? 0); });

console.log('\nDomel local demo on the LAN');
if (addresses.length) for (const address of addresses) console.log(`  http://${address}:5174`);
else console.log('  http://127.0.0.1:5174');
console.log(`  API: http://${addresses[0] ?? '127.0.0.1'}:8788 (bound to 0.0.0.0)`);
console.log('No authentication: anyone on this network can use it and spend the DeepSeek key.\n');

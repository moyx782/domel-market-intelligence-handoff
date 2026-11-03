// Static frontend content check: every literal t('...') key used in the UI must
// have a Chinese translation. This catches untranslated labels without a
// browser and keeps the content coverage honest across all pages/components.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const SRC = 'src';
const files = readdirSync(SRC).filter(name => /\.(tsx|ts)$/.test(name));

function unescapeKey(raw) {
 return raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
}

// All zh dictionary keys live in i18n.tsx and the messages-*.ts modules.
const translated = new Set();
for (const name of files.filter(name => name === 'i18n.tsx' || /^messages-/.test(name))) {
 const text = readFileSync(join(SRC, name), 'utf8');
 for (const match of text.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:/gm)) translated.add(unescapeKey(match[1]));
}

// UI literals passed to t(...). Dynamic keys (t(variable)) are covered by the
// runtime acceptance tests instead.
const used = new Map();
for (const name of files.filter(name => name.endsWith('.tsx'))) {
 const text = readFileSync(join(SRC, name), 'utf8');
 for (const match of text.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
  const key = unescapeKey(match[1]);
  if (!used.has(key)) used.set(key, name);
 }
}

test('every literal UI translation key has a Chinese translation', () => {
 const missing = [...used.entries()].filter(([key]) => !translated.has(key)).map(([key, file]) => `${file}: ${JSON.stringify(key)}`);
 assert.deepEqual(missing, [], 'Add zh translations in src/i18n.tsx or src/messages-*.ts:\n' + missing.join('\n'));
});

test('translated strings are non-empty', () => {
 const empty = [];
 for (const name of files.filter(name => name === 'i18n.tsx' || /^messages-/.test(name))) {
  const text = readFileSync(join(SRC, name), 'utf8');
  for (const match of text.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:\s*(['"])\2\s*,/gm)) empty.push(name + ': ' + match[1]);
 }
 assert.deepEqual(empty, [], 'Empty zh translations:\n' + empty.join('\n'));
});

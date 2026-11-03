import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const seed = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'seed', 'company-domel.json'), 'utf8'));

test('built-in Domel company profile is complete and sourced', () => {
 assert.equal(seed.id, 'domel');
 assert.equal(seed.website, 'https://www.domel.com');
 assert.ok(seed.aliases.some(alias => alias.includes('多麦机电')));
 assert.ok(seed.industries.length >= 5);
 assert.ok(seed.products.length >= 8);
 assert.ok(seed.solutions.some(solution => /ventilation/i.test(solution)));
 assert.ok(seed.keywords.en.includes('EC motor'));
 assert.ok(seed.keywords.zh.includes('暖通'));
 assert.ok(seed.sources.length >= 2);
 for (const source of seed.sources) assert.match(source.url, /^https:\/\//);
 assert.match(seed.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}$/);
});

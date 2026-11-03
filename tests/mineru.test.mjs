import test from 'node:test';
import assert from 'node:assert/strict';
import {documentAvailability, mineruConfig, mineruStatus} from '../server/mineru.mjs';

test('MinerU configuration supports official and self-hosted providers without leaking the token', () => {
 const off = mineruStatus({});
 assert.equal(off.provider, 'none');
 assert.equal(off.configured, false);
 assert.equal(off.baseUrl, null);

 const official = mineruConfig({MINERU_PROVIDER: 'official', MINERU_API_TOKEN: 'secret-token'});
 assert.equal(official.provider, 'official');
 assert.equal(official.configured, true);
 assert.equal(official.baseUrl, 'https://mineru.net/api/v4');
 assert.equal(mineruStatus({MINERU_PROVIDER: 'official', MINERU_API_TOKEN: 'secret-token'}).configured, true);
 assert.ok(!JSON.stringify(mineruStatus({MINERU_PROVIDER: 'official', MINERU_API_TOKEN: 'secret-token'})).includes('secret-token'));

 const local = mineruConfig({MINERU_PROVIDER: 'local', MINERU_LOCAL_URL: 'http://127.0.0.1:8000'});
 assert.equal(local.provider, 'local');
 assert.equal(local.configured, true);
 assert.equal(local.baseUrl, 'http://127.0.0.1:8000');

 const invalid = mineruConfig({MINERU_PROVIDER: 'bogus'});
 assert.equal(invalid.provider, 'none');
});

test('MinerU local URL allows any host, port and base path', () => {
 const custom = mineruConfig({MINERU_PROVIDER: 'local', MINERU_LOCAL_URL: 'https://mineru.corp.example:8443/api/'});
 assert.equal(custom.baseUrl, 'https://mineru.corp.example:8443/api');
 const override = mineruConfig({}, {provider: 'local', localUrl: 'http://10.0.0.5:9000/mineru'});
 assert.equal(override.baseUrl, 'http://10.0.0.5:9000/mineru');
 const invalid = mineruConfig({MINERU_PROVIDER: 'local', MINERU_LOCAL_URL: 'not-a-url'});
 assert.equal(invalid.baseUrl, 'http://127.0.0.1:8000');
});

test('document availability is classified without downloading', () => {
 assert.equal(documentAvailability('https://example.com/list.pdf'), 'downloadable');
 assert.equal(documentAvailability('https://example.com/list.xlsx'), 'downloadable');
 assert.equal(documentAvailability('https://example.com/exhibitors'), 'linked');
 assert.equal(documentAvailability('https://example.com/'), 'linked');
 assert.equal(documentAvailability('ftp://example.com/list.pdf'), 'unknown');
 assert.equal(documentAvailability('not a url'), 'unknown');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {passwordIntent,passwordError,authRedirect} from '../src/auth-flow.mjs';
test('invitation and recovery callbacks open password setup before SDK consumes hash',()=>{
 for(const url of ['https://example.com/#type=invite&access_token=redacted','https://example.com/#type=recovery','https://example.com/?auth=set-password&code=redacted'])assert.equal(passwordIntent(url),true);
 assert.equal(passwordIntent('https://example.com/'),false);
 assert.equal(passwordIntent('https://example.com/#type=signup'),false);
});
test('reset redirect uses current origin and fixed local route',()=>assert.equal(authRedirect('https://example.com'), 'https://example.com/?auth=set-password'));
test('password setup rejects short and mismatched input',()=>{
 assert.ok(passwordError('short','short'));assert.ok(passwordError('twelve-characters','other-password'));
 assert.equal(passwordError('twelve-characters','twelve-characters'),'');
});

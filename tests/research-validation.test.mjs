import test from 'node:test';
import assert from 'node:assert/strict';
import {validateScope,validateFindings} from '../supabase/functions/_shared/research-validation.mjs';
const p={title:'Quarterly review',question:'What changed?',segment:'HVAC motors',market:'EU',quarter:'2026-Q3',competitors:['A'],focus:['Technology'],source_urls:['https://example.com/news']};
const quote='A introduced an efficient industrial motor for ventilation.';
const f={competitor:'A',field:'Technology',text:'A introduced a motor.',quote};
test('guided research retains supplied question, quarter, competitors and sources',()=>assert.deepEqual(validateScope(p),p));
test('research rejects malformed scope, duplicates and unsupported source protocols',()=>{
 for(const patch of [{question:' '},{quarter:'2026-Q5'},{competitors:[]},{competitors:['A',' a ']},{competitors:['A','B','C','D']},{focus:[]},{focus:[' ' ]},{source_urls:['http://example.com']},{source_urls:['https://user:secret@example.com']},{source_urls:Array(16).fill('https://example.com')}])assert.throws(()=>validateScope({...p,...patch}));
});
test('candidate evidence must match exact retrieved passage and requested scope',()=>{
 assert.deepEqual(validateFindings({findings:[f]},p,{text:quote}),[f]);
 for(const patch of [{competitor:'Other'},{field:'Market activity'},{quote:'An invented passage that does not occur in this source.'},{quote:'short'},{text:''}])assert.throws(()=>validateFindings({findings:[{...f,...patch}]},p,{text:quote}));
});
test('malformed and oversized AI output fail; no evidence returns no candidates',()=>{
 for(const parsed of [null,{}, {findings:'bad'}, {findings:[null]}, {findings:Array(6).fill(f)}])assert.throws(()=>validateFindings(parsed,p,{text:quote}));
 assert.deepEqual(validateFindings({findings:[]},p,{text:quote}),[]);
});
test('one unsupported candidate rejects the entire page batch',()=>assert.throws(()=>validateFindings({findings:[f,{...f,competitor:'invented'}]},p,{text:quote})));

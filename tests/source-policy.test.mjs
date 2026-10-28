import test from 'node:test';
import assert from 'node:assert/strict';
import {sourcePolicy,publicSourceUrl,publicAddress} from '../supabase/functions/_shared/source-policy.mjs';
import {createDeepSeekSources} from '../supabase/functions/_shared/deepseek-search.mjs';
test('empty configuration has no presets or domain restriction, including old single-domain setting',()=>{
 const policy=sourcePolicy(k=>k==='SOURCE_ALLOWED_DOMAINS'?'www.ebmpapst.com':undefined);
 assert.deepEqual(policy,{restrictedDomains:[],defaultSourceUrls:[]});
 for(const host of ['www.ebmpapst.com','www.nidec.com','www.ziehl-abegg.com'])assert.equal(publicSourceUrl(`https://${host}/news`),`https://${host}/news`);
});
test('defaults remain preferences while an explicit administrator restriction is enforced',()=>{
 const policy=sourcePolicy(k=>({SOURCE_DEFAULT_URLS:'["https://example.com/news#one","https://example.com/news#two"]'}[k]));
 assert.deepEqual(policy.defaultSourceUrls,['https://example.com/news']);assert.deepEqual(policy.restrictedDomains,[]);
 assert.equal(publicSourceUrl('https://other.org/news'),'https://other.org/news');
 assert.throws(()=>publicSourceUrl('https://other.org/news',['example.com']),/restricted/);
 for(const value of ['not json','{}','["http://example.com"]'])assert.throws(()=>sourcePolicy(k=>k==='SOURCE_DEFAULT_URLS'?value:undefined));
});
test('URL policy rejects credentials, non-HTTPS, IP literals and local/reserved names',()=>{
 for(const url of ['http://example.com','https://user:password@example.com','https://example.com:8080','https://127.0.0.1','https://2130706433','https://0x7f000001','https://[::1]','https://localhost','https://host.local','https://host.internal','https://host.test','https://host.localhost.'])assert.throws(()=>publicSourceUrl(url),url);
 assert.equal(publicSourceUrl('https://EXAMPLE.COM.:443/page#fragment'),'https://example.com/page');
});
test('native retrieval DNS guard rejects private and special-use addresses',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.0.1','100.64.0.1','169.254.169.254','0.0.0.0','224.0.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
});
test('unrestricted search has no site filter and accepts multiple public websites',async()=>{
 const urls=['https://www.nidec.com/news','https://www.ziehl-abegg.com/news'];const queries=[];
 const adapter=createDeepSeekSources({apiKey:'test-key',allowUrl:publicSourceUrl,fetchImpl:async(endpoint,options)=>{queries.push(JSON.parse(options.body).query);return Response.json({results:urls.map(url=>({url}))});}});
 const result=await adapter.discover({competitors:['Motor company'],segment:'motors',market:'EU',quarter:'2026-Q3',focus:['Technology'],question:'What changed?'});
 assert.deepEqual(result,urls);assert.ok(queries.every(q=>!q.includes('site:')));
});

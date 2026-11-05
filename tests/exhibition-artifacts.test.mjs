import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollector} from '../server/collector.mjs';

test('capture mode retains a downloadable document even when OCR is unavailable',async()=>{
 const pdf=Buffer.from('%PDF-1.4 original-file-fixture');
 const collector=createCollector({fetchImpl:async url=>String(url).endsWith('/robots.txt')?new Response('',{status:404}):new Response(pdf,{headers:{'content-type':'application/pdf'}})});
 try{const page=await collector.collect('https://example.com/exhibitors.pdf',{captureArtifacts:true});assert.equal(page.ok,true);assert.equal(page.engine,'document-unparsed');assert.equal(page.text,'');assert.deepEqual(Buffer.from(page.artifact.buffer),pdf);assert.equal(page.artifact.mime,'application/pdf');}finally{await collector.close();}
});
test('dynamic page capture requests and retains its real browser screenshot bytes',async()=>{
 const image=Buffer.from('rendered screenshot fixture');let screenshotCalls=0;
 const rendered='<html><title>Exhibitors</title><body><main>'+('Appliance manufacturers and their product catalogue entries. '.repeat(20))+'</main></body></html>';
 const browser={newPage:async()=>({goto:async()=>{},waitForTimeout:async()=>{},content:async()=>rendered,url:()=> 'https://example.com/directory',screenshot:async()=>{screenshotCalls++;return image;},close:async()=>{}}),close:async()=>{}};
 const collector=createCollector({fetchImpl:async url=>String(url).endsWith('/robots.txt')?new Response('',{status:404}):new Response('<html><body><div id="root">loading</div></body></html>',{headers:{'content-type':'text/html'}}),launchBrowser:async()=>browser});
 try{const page=await collector.collect('https://example.com/directory',{captureArtifacts:true});assert.equal(page.ok,true);assert.equal(page.engine,'browser');assert.equal(screenshotCalls,1);assert.deepEqual(page.artifact.buffer,image);assert.equal(page.artifact.mime,'image/png');}finally{await collector.close();}
});

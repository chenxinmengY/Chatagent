import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {sandbox} from './helpers.mjs';import * as source from '../packages/diy-plugins/media-source.mjs';
const edge='https://fixture.edge.mountaintoys.cn:4483/video',cdn='https://fixture.bilivideo.com/video',backup='https://backup.bilivideo.com/video';

test('media downloads choose an approved backup without contacting an unsupported primary origin',async t=>{
 const {root}=sandbox(t),file=path.join(root,'video.mp4'),calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(String(url));assert.equal(options.redirect,'error');return new Response('video');});
 await source.downloadMedia([edge,cdn,cdn],file,100,new AbortController().signal);
 assert.deepEqual(calls,[cdn]);assert.equal(fs.readFileSync(file,'utf8'),'video');
});

test('an interrupted CDN stream removes partial bytes before trying another approved URL',async t=>{
 const {root}=sandbox(t),file=path.join(root,'video.mp4'),calls=[];
 t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));if(calls.length===1)return {ok:true,headers:new Headers(),body:(async function*(){yield Buffer.from('partial');throw TypeError('synthetic disconnect');})()};return new Response('complete');});
 await source.downloadMedia([cdn,backup],file,100,new AbortController().signal);
 assert.deepEqual(calls,[cdn,backup]);assert.equal(fs.readFileSync(file,'utf8'),'complete');
});

test('media fallback still rejects HTTP, credentials, lookalike origins and redirects',async t=>{
 const {root}=sandbox(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/'}});});
 await assert.rejects(source.downloadMedia(['http://cdn.bilivideo.com/a','https://user@cdn.bilivideo.com/a','https://bilivideo.com.evil.test/a',edge],path.join(root,'invalid'),100,new AbortController().signal),/PLUGIN_MEDIA_ORIGIN_INVALID/);assert.equal(calls,0);
 await assert.rejects(source.downloadMedia([cdn],path.join(root,'redirect'),100,new AbortController().signal),/PLUGIN_MEDIA_DOWNLOAD_FAILED/);assert.equal(calls,1);
});

test('user cancellation stops fallback and removes partial files',async t=>{
 const {root}=sandbox(t),file=path.join(root,'video.mp4'),controller=new AbortController();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:true,headers:new Headers(),body:(async function*(){yield Buffer.from('partial');controller.abort();yield Buffer.from('more');})()};});
 await assert.rejects(source.downloadMedia([cdn,backup],file,100,controller.signal));assert.equal(calls,1);assert.equal(fs.existsSync(file),false);
});

test('oversized streams leave no partial file and an existing destination is preserved',async t=>{
 const {root}=sandbox(t),file=path.join(root,'video.mp4');t.mock.method(globalThis,'fetch',async()=>new Response('too large'));
 await assert.rejects(source.downloadMedia([cdn],file,2,new AbortController().signal),/PLUGIN_MEDIA_TOO_LARGE/);assert.equal(fs.existsSync(file),false);
 fs.writeFileSync(file,'existing');await assert.rejects(source.downloadMedia([cdn,backup],file,100,new AbortController().signal),/EEXIST/);assert.equal(fs.readFileSync(file,'utf8'),'existing');
});

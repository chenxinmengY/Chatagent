import test from 'node:test';import assert from 'node:assert/strict';
import {sandbox} from './helpers.mjs';import {createDiyPlugins} from '../packages/diy-plugins/runtime.mjs';

test('video feelings are personal observations grounded in supplied details rather than a report to the user',async t=>{
 let cleanup;const box=sandbox({after:fn=>cleanup=fn});let actual;
 const runtime=createDiyPlugins({root:box.root,sessionId:'style-check',persona:()=>({name:'测试人格',text:'对主人称您，喜欢观察生活细节。'}),history:()=>[],publish:()=>{},mediaSource:async()=>({title:'不作为画面证据的标题',bvid:'BV1rDx46VENg',images:[Buffer.from('frame')],subtitles:[],transcript:'门口的牌子写着今天休息。',evidence:{frameCount:1,audioSeconds:4,originalAudioToModel:false}}),generate:async args=>{actual=args;return '门口那块“今天休息”的牌子一出来，前面忙活半天的铺垫就变得好笑了。';}});
 t.after(async()=>{await runtime.close();cleanup();});runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,enabled:true});runtime.start('media-browser',{requestId:'one-observation'});await runtime.settled('media-browser');
 assert.equal(runtime.readJob('one-observation').state,'completed');assert.match(actual.prompt,/自己的.*浏览/);assert.match(actual.prompt,/不是.*回复/);assert.match(actual.prompt,/具体/);assert.match(actual.prompt,/不.*(?:主人|用户).*称呼|不.*称呼.*(?:主人|用户)/);assert.match(actual.prompt,/不.*(?:重复|复述).*限制/);assert.match(actual.prompt,/不能.*(?:音乐|声音)|不.*(?:推断|编造).*声音/);assert.ok(actual.prompt.includes('门口的牌子写着今天休息。'));assert.equal(actual.images.length,1);assert.ok(runtime.status('media-browser')[0].records[0].text.includes('今天休息'));
});

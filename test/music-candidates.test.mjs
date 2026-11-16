import test from 'node:test';import assert from 'node:assert/strict';
import {expandMusicCandidates} from '../packages/dsh-bridge/music-candidates.mjs';
import {isMusicCandidate} from '../packages/local-user-plugins/packages/wechat-music/content-policy.mjs';
const song=(bvid,title)=>({bvid,title,duration:120,tid:28,videos:1,tname:'原创音乐'});
test('an exhausted music ranking is supplemented with fresh eligible music without reusing old audio',async()=>{
 let calls=0;const choose=expandMusicCandidates({ranked:async()=>[{bvid:'BV1rDx46VENg'}],isMusicCandidate,fetcher:async(url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(new URL(url).hostname,'api.bilibili.com');return Response.json({code:0,data:{archives:[song('BV1rDx46VENg','《旧歌》'),song('BV1ky421i7dL','《新歌》'),song('BV1bY4g6yEF6','吉他教学：歌曲演奏')]}});}});
 const found=await choose({excluded:['BV1rDx46VENg']});assert.equal(calls,1);assert.deepEqual(found.map(r=>r.bvid),['BV1ky421i7dL']);assert.equal(found[0].seconds,120);
});
test('a sufficient fresh ranking makes no additional feed request',async()=>{
 const ranked=[{bvid:'BV1rDx46VENg'},{bvid:'BV1ky421i7dL'},{bvid:'BV1bY4g6yEF6'}],choose=expandMusicCandidates({ranked:async()=>ranked,isMusicCandidate,fetcher:()=>assert.fail('No unnecessary request')});assert.deepEqual(await choose(),ranked);
});
test('an aborted ranking request never starts a fallback request',async()=>{
 const controller=new AbortController(),choose=expandMusicCandidates({ranked:async()=>{controller.abort();throw Error('cancelled');},isMusicCandidate,fetcher:()=>assert.fail('Cancelled')});await assert.rejects(choose({signal:controller.signal}));
});

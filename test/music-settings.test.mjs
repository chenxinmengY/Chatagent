import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {connectMusicSettings} from '../packages/dsh-bridge/music-settings.mjs';import {sandbox} from './helpers.mjs';
import {automaticMusic} from '../packages/dsh-bridge/automatic-music.mjs';import {pathToFileURL} from 'node:url';
const backend=path.resolve('packages/local-user-plugins/packages/media-experiences/settings.mjs');
test('music settings save through the installed backend validator, preserve video settings and reject stale revisions',{skip:!fs.existsSync(backend)},async t=>{
 const {root}=sandbox(t),target=path.join(root,'packages/media-experiences/settings.mjs');fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(backend,target);
 const settings=await connectMusicSettings(root),before=settings.read(),next={...before.settings,dailyRounds:7,windows:[{start:'23:15',end:'01:45'}],idleMinutes:45,gapMinutes:18};
 const saved=settings.save({section:'music',revision:before.revision,settings:next});assert.deepEqual(settings.read(),saved);assert.deepEqual(saved.settings,next);assert.notEqual(saved.revision,before.revision);
 const file=path.join(root,'config/media-settings.json'),bytes=fs.readFileSync(file),video=JSON.parse(bytes).video;assert.equal(video.dailyRounds,3);assert.deepEqual(video.windows,[{start:'12:30',end:'14:30'}]);
 assert.throws(()=>settings.save({section:'music',revision:before.revision,settings:next}),/PLUGIN_SETTINGS_CHANGED/);
 for(const patch of [{roundMinutes:6},{dailyRounds:51},{windows:[{start:'23:15',end:'23:15'}]},{tokenLimit:10000},{share:true}])assert.throws(()=>settings.save({section:'music',revision:saved.revision,settings:{...next,...patch}}),/PLUGIN_SETTINGS_INVALID/);
 assert.deepEqual(fs.readFileSync(file),bytes);
});

test('automatic music reads saved policy changes on the next tick',{skip:!fs.existsSync(backend)},async t=>{
 const {root}=sandbox(t),target=path.join(root,'packages/media-experiences/settings.mjs');fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(backend,target);
 const settings=await connectMusicSettings(root),{mediaScheduleDue}=await import(pathToFileURL(target).href);let at=Date.parse('2026-11-06T01:00:00Z'),calls=0;
 const save=patch=>{const current=settings.read();settings.save({section:'music',revision:current.revision,settings:{...current.settings,...patch}});};
 save({enabled:false,windows:[],allowIdleOutsideWindows:true,idleMinutes:45});
 const runner=automaticMusic({root,policy:()=>settings.read().settings,due:mediaScheduleDue,now:()=>at,lastChat:()=>at-30*60000,enabled:()=>true,busy:()=>false,book:{usage:()=>({times:[],rounds:[],attempts:[],pendingMusic:0}),reserveRound(){},setOutcome(){},finishRound(){}},candidates:async()=>{calls++;return [];},generate:async()=>'STOP',persona:()=>'',listen:async()=>assert.fail('no observation should be created')});
 try{at+=60*60000;await runner.tick();assert.equal(calls,0);save({enabled:true});await runner.tick();assert.equal(calls,0);save({idleMinutes:20});await runner.tick();assert.equal(calls,1);assert.equal(runner.status().phase,'declined');}finally{await runner.close();}
});

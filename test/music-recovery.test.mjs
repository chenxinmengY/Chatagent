import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {mediaLedger} from '../packages/local-user-plugins/packages/media-experiences/ledger-chatagent.mjs';
import {DEFAULT_MEDIA_SETTINGS} from '../packages/local-user-plugins/packages/media-experiences/settings.mjs';
import {automaticMusic} from '../packages/dsh-bridge/automatic-music.mjs';import {sandbox} from './helpers.mjs';
function fixture(t,settings={}){
 let clean;const {root}=sandbox({after:fn=>clean=fn});let clock=Date.parse('2026-11-07T05:00:00Z');
 fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/media-settings.json'),JSON.stringify({...DEFAULT_MEDIA_SETTINGS,music:{...DEFAULT_MEDIA_SETTINGS.music,...settings}}));
 const book=mediaLedger({root,account:'a'.repeat(64),key:'wechat:private:12345',now:()=>clock,musicRecovery:true});
 t.after(()=>{book.close();clean();});return {root,book,now:()=>clock,advance:()=>clock+=60000};
}
test('a confirmed manual listen restores new automatic opportunities without deleting failures or replaying them',async t=>{
 const f=fixture(t);for(let i=0;i<10;i++){f.book.reserveRound('music','old-'+i);f.book.setOutcome('old-'+i,{status:'unknown',bvid:'BV1rDx46VENg'});f.book.finishRound('old-'+i,'unknown');f.advance();}
 const old=f.book.db.prepare("SELECT * FROM rounds WHERE origin='autonomous' ORDER BY id").all();
 assert.throws(()=>f.book.reserveRound('music','before-recovery'),/MEDIA_DAILY_ATTEMPT_LIMIT/);
 f.book.reserveRound('music','failed-invite',{origin:'invited'});f.book.finishRound('failed-invite','unknown');f.advance();
 assert.throws(()=>f.book.reserveRound('music','still-blocked'),/MEDIA_DAILY_ATTEMPT_LIMIT/);
 f.book.reserveRound('music','confirmed-invite',{origin:'invited'});f.book.confirmMusic('confirmed-invite',60,'BV1rDx46VENg');f.book.finishRound('confirmed-invite','completed');f.advance();
 assert.equal(f.book.usage().attempts[0].count,10);assert.equal(f.book.usage().musicAttemptsSinceRecovery,0);
 let calls=0;const runner=automaticMusic({root:f.root,book:f.book,now:f.now,policy:()=>({...DEFAULT_MEDIA_SETTINGS.music}),due:()=>true,enabled:()=>true,ready:()=>true,busy:()=>false,lastChat:()=>0,candidates:async()=>{calls++;return [];},generate:async()=>assert.fail('No candidate must not spend model tokens'),persona:()=>'',listen:async()=>assert.fail('Never replay old audio')});
 assert.equal(runner.status().schedule.reason,'ready');await runner.tick();await runner.close();assert.equal(calls,1);
 assert.deepEqual(f.book.db.prepare("SELECT * FROM rounds WHERE id LIKE 'old-%' ORDER BY id").all(),old);
 for(let i=1;i<10;i++){f.advance();f.book.reserveRound('music','new-'+i);f.book.finishRound('new-'+i,'unknown');}
 assert.throws(()=>f.book.reserveRound('music','new-overflow'),/MEDIA_DAILY_ATTEMPT_LIMIT/);
});
test('manual recovery preserves successful automatic daily counts and actual listening time',t=>{
 const f=fixture(t,{dailyRounds:20});for(let i=0;i<5;i++){f.book.reserveRound('music','heard-'+i,{duration:300000});f.book.confirmMusic('heard-'+i,300,'BV1rDx46VENg');f.book.finishRound('heard-'+i,'completed');f.advance();}
 f.book.reserveRound('music','manual',{origin:'invited'});f.book.confirmMusic('manual',60,'BV1rDx46VENg');f.book.finishRound('manual','completed');f.advance();
 assert.equal(f.book.usage().rounds[0].count,5);assert.equal(f.book.usage().times[0].milliseconds,1500000);assert.throws(()=>f.book.reserveRound('music','past-time'),/MEDIA_DAILY_TIME_LIMIT/);
});

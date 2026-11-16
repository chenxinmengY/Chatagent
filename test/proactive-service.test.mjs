import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startService} from '../apps/service/server.mjs';
import {Preferences} from '../packages/conversation/preferences.mjs';
import {sandbox} from './helpers.mjs';

async function fixture(t){
 let cleanup,at=Date.parse('2026-11-06T12:00:00+08:00'),calls=0,replies=0,available=true,backgroundBusy=false;
 const box=sandbox({after:fn=>cleanup=fn}),service=await startService({dataRoot:path.join(box.root,'chat'),now:()=>at,backend:{
  async reply(){replies++;return 'synthetic reply';},async lookupResult(){return null;},
  async canAccept({proactive=false}={}){return available&&(!proactive||!backgroundBusy);},async proactive(){calls++;return 'SILENT';}
 }});
 t.after(async()=>{await service.close();cleanup();});
 const preferences=new Preferences(service.store),p=preferences.read();
 Object.assign(p.policy,{proactiveEnabled:true,proactiveSchedule:'periodic',proactiveMinIntervalMinutes:35,proactiveJitterMinutes:0,proactiveIdleMinutes:10,proactiveMaxPerDay:0,maxMessages:1});preferences.save(p);
 const submit=id=>service.store.submit({deviceId:'synthetic',clientMessageId:id,text:'synthetic '+id,queuedAt:at});
 const unknown=()=>{const row=submit('unknown');service.store.claim();service.store.unknown(row.id);return service.store.message(row.id);};
 return {service,submit,unknown,advance:minutes=>at+=minutes*60000,calls:()=>calls,replies:()=>replies,setAvailable:value=>available=value,setBackgroundBusy:value=>backgroundBusy=value};
}

test('a successful later chat releases proactive scheduling without replaying or changing old unknown work',async t=>{
 const f=await fixture(t),old=f.unknown();f.advance(1);const fresh=f.submit('fresh');await f.service.tick();
 assert.equal(f.service.store.message(fresh.id).state,'completed');assert.equal(f.replies(),1);
 f.advance(11);await f.service.tick();f.advance(35);await f.service.tick();
 assert.equal(f.calls(),1);assert.deepEqual(f.service.store.message(old.id),old);assert.equal(f.replies(),1);
});

test('the latest unresolved chat still blocks proactive scheduling',async t=>{
 const f=await fixture(t),old=f.unknown();f.advance(120);await f.service.tick();
 assert.equal(f.calls(),0);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM proactive_runs').get().n,0);
 assert.deepEqual(f.service.store.message(old.id),old);assert.equal(f.replies(),0);
});

test('a backend already processing another task delays proactive work without creating an unknown attempt',async t=>{
 const f=await fixture(t);f.submit('fresh');await f.service.tick();f.advance(11);await f.service.tick();f.advance(35);f.setAvailable(false);
 await f.service.tick();assert.equal(f.calls(),0);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM proactive_runs').get().n,0);
 f.setAvailable(true);await f.service.tick();assert.equal(f.calls(),1);
});

test('a historical unknown does not bypass quiet hours or an unconfirmed new message',async t=>{
 const f=await fixture(t);f.unknown();f.advance(1);f.submit('fresh');await f.service.tick();f.advance(11);await f.service.tick();
 const waiting=f.submit('needs-confirmation');f.service.store.update(waiting.id,'awaiting_confirmation');f.advance(35);await f.service.tick();assert.equal(f.calls(),0);
 f.service.store.update(waiting.id,'cancelled');f.advance(600);await f.service.tick();assert.equal(f.calls(),0);
 assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM proactive_runs').get().n,0);
});

test('proactive scheduling waits for a background plugin but still dispatches new user messages',async t=>{
 const f=await fixture(t);f.submit('fresh');await f.service.tick();f.advance(11);await f.service.tick();f.advance(35);f.setBackgroundBusy(true);
 await f.service.tick();assert.equal(f.calls(),0);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM proactive_runs').get().n,0);
 const message=f.submit('interrupt');await f.service.tick();assert.equal(f.service.store.message(message.id).state,'completed');assert.equal(f.replies(),2);
 f.advance(11);f.setBackgroundBusy(false);await f.service.tick();assert.equal(f.calls(),1);
});

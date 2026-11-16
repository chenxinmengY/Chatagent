import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Preferences} from '../packages/conversation/preferences.mjs';
import {ChatStore} from '../packages/conversation/store.mjs';
import {startService} from '../apps/service/server.mjs';
import {sandbox} from './helpers.mjs';
const personas=[{id:'active',name:'正在使用',text:'保留当前角色的原文',categoryId:null},{id:'unused',name:'备用卡片',text:'备用人格原文',categoryId:null}];
test('deleting a template keeps bound personas, removes unused cards, and permits reusing its name',t=>{
 const box=sandbox(t),file=path.join(box.root,'chat.sqlite');let store=new ChatStore(file);
 try{
  let preferences=new Preferences(store,{personas:structuredClone(personas),activePersonaId:'active'}),draft=preferences.read();draft.personas.forEach(p=>p.archived=true);const saved=preferences.save(draft);
  assert.deepEqual(saved.personas.map(p=>p.id),['active']);assert.equal(preferences.forMode('social').persona.text,personas[0].text);assert.equal(preferences.forMode('assistant').persona.text,personas[0].text);assert.throws(()=>preferences.save(draft),/PREFERENCES_CHANGED/);
  store.close();store=new ChatStore(file);preferences=new Preferences(store);assert.equal(preferences.read().personas[0].archived,true);assert.equal(preferences.forMode('social').persona.id,'active');
  draft=preferences.read();draft.personas.push({...personas[0],id:'replacement',text:'同名新卡片'});preferences.save(draft);assert.equal(preferences.forMode('social').persona.text,personas[0].text);
  draft=preferences.read();for(const mode of Object.values(draft.modes))mode.personaId='replacement';preferences.save(draft);assert.deepEqual(preferences.read().personas.map(p=>p.id),['replacement']);
  const history=store.db.prepare("SELECT value FROM settings WHERE key LIKE 'preferences-history-%'").all().map(r=>JSON.parse(r.value));assert.ok(history.some(p=>p.personas.some(p=>p.id==='unused'&&!p.archived)));
 }finally{store.close();}
});
test('deleting a shared template preserves existing chats and blocks it for new chats',{timeout:20000},async t=>{
 let service;t.after(()=>service?.close());const box=sandbox(t),backend=id=>({kind:'dsh-bridge',externalRuntime:true,status:()=>({modeBindings:[{mode:'social',session_id:'session-'+id}]}),bridgeStatus:async()=>({connected:true,tools:[]}),openChat:async id=>backend(id)});
 service=await startService({dataRoot:path.join(box.root,'chat'),backend:backend('default'),preferencesSeed:{personas:structuredClone(personas),activePersonaId:'active'}});
 const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},call=async(route,body)=>{const response=await fetch(service.url+route,{method:body?'POST':'GET',headers,signal:AbortSignal.timeout(5000),...body?{body:JSON.stringify(body)}:{}});return {status:response.status,value:await response.json()};};
 const id=randomUUID();assert.equal((await call('/v1/chats',{id,name:'已有聊天',personaId:'active'})).status,200);const childBefore=(await call('/v1/chats/'+id+'/v1/preferences')).value;
 const draft=(await call('/v1/preferences')).value;draft.personas.find(p=>p.id==='active').archived=true;assert.equal((await call('/v1/preferences',draft)).status,200);
 assert.deepEqual((await call('/v1/chats/'+id+'/v1/preferences')).value,childBefore);const root=(await call('/v1/chat-settings')).value;assert.equal(root.preferences.modes.social.personaId,'active');assert.equal(root.preferences.personas.find(p=>p.id==='active').text,personas[0].text);
 assert.equal((await call('/v1/chats',{id:randomUUID(),name:'不能复用已删除卡片',personaId:'active'})).value.error,'INVALID_PERSONA');const fresh=randomUUID();assert.equal((await call('/v1/chats',{id:fresh,name:'新聊天',personaId:'unused'})).status,200);assert.deepEqual((await call('/v1/chats/'+fresh+'/v1/preferences')).value.personas.map(p=>p.id),['unused']);
 assert.ok((await call('/v1/chats')).value.chats.filter(c=>['default',id].includes(c.id)).every(c=>c.personaName===personas[0].name));
 // An existing chat can adopt a replacement with the deleted template's name,
 // while its other mode keeps the original persona copy.
 const next=(await call('/v1/preferences')).value,replacement={...personas[0],id:'replacement'};next.personas.push(replacement);assert.equal((await call('/v1/preferences',next)).status,200);
 const settings=(await call('/v1/chats/'+id+'/v1/chat-settings')).value;settings.preferences.personas.find(p=>p.id==='active').archived=true;settings.preferences.personas.push(replacement);settings.preferences.modes.social.personaId=replacement.id;
 const switched=await call('/v1/chats/'+id+'/v1/chat-settings',settings);assert.equal(switched.status,200);const saved=switched.value.preferences;assert.equal(saved.modes.social.personaId,replacement.id);assert.equal(saved.modes.assistant.personaId,'active');assert.equal(saved.personas.find(p=>p.id==='active').text,personas[0].text);
});

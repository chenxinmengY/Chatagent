import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createDshBridgeRuntime} from '../../packages/dsh-adapter/bridge-runtime.mjs';
const [sdk,memoryEntry,root]=process.argv.slice(2);
fs.mkdirSync(root,{recursive:true});process.env.DSH_HOME=path.join(root,'home');fs.mkdirSync(process.env.DSH_HOME);
const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
fs.writeFileSync(path.join(process.env.DSH_HOME,'project-memory-settings.json'),JSON.stringify({enabled:true,automaticSummary:true,recordsToInject:5,disabledWorkspaces:[cwd.toLowerCase()]}));
const load=name=>import(pathToFileURL(path.join(sdk,name,'lib/index.js')).href);
const [cordis,sessions,agents,llm,prompt,tools,projection,persistence,loop,memory,bridge]=await Promise.all([
 ...['cordis','dsh-session','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-session-persistence-jsonl','dsh-agent-loop'].map(load),
 import(pathToFileURL(memoryEntry).href),import(pathToFileURL(path.resolve(process.env.CHATAGENT_SHARED_BRIDGE_ENTRY??'packages/dsh-bridge/index.mjs')).href)
]);
const ctx=new cordis.Context(),workspaces=[],captured=[],ownMemory=new Map();let externalCalls=0,fiber,runtime,childA,childB;
const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{if(new URL(typeof input==='string'||input instanceof URL?input:input.url).hostname!=='127.0.0.1'){externalCalls++;throw Error('EXTERNAL_NETWORK_REFUSED');}return realFetch(input,{...init,headers:{...init?.headers,Connection:'close'}});};
const portProbe=net.createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
const token='synthetic-shared-workspace-token'.repeat(3),tokenFile=path.join(root,'token');fs.writeFileSync(tokenFile,token);
try{
 for(const [plugin,config] of [[sessions.default,{}],[agents.default,{}],[llm.default,{}],[prompt.default,{includeRuntimeContext:false}],[tools.default,{mode:'native'}],[projection.default,{}],[persistence,{root:path.join(root,'sessions'),compression:'none'}]])await ctx.plugin(plugin,config);
 ctx.provide('profileContext',{installAnchor:'D:/dsh/resources/app/dsh/package.json'});
 ctx.provide('workspaceRegistry',{
  archivedSessionIds:[],async archiveSession(id){if(!this.archivedSessionIds.includes(id))this.archivedSessionIds.push(id);},list:()=>workspaces,async resolveByPath(value){return workspaces.find(w=>w.path===value);},
  async create(value,title){assert.equal(workspaces.length,0,'Every Chatagent chat must reuse the primary workspace');const workspace={id:randomUUID(),path:value,title,sessionIds:[],async detachSession(id){this.sessionIds=this.sessionIds.filter(value=>value!==id);},async attachSession(id){assert.equal(ctx.sessions.get(id).header.cwd,this.path,'Native workspace membership validates the durable session cwd');if(!this.sessionIds.includes(id))this.sessionIds.push(id);}};workspaces.push(workspace);return workspace;}
 });
 ctx.provide('sessionController',{
  agents:{resolveAgent:async id=>({agent:ctx.agents.get(id)})},
  async create({sessionId,workspaceId}){const workspace=workspaces.find(w=>w.id===workspaceId);const {agent}=await ctx.agents.create({sessionId,meta:{cwd:workspace.path},agentOptions:{provider:'synthetic',model:'fixture'}});agent.ctx.systemPrompt.context({name:'memory',order:900,required:true,text:()=>ownMemory.get(sessionId)??''});},
  async rename(){},async prompt({sessionId,requestId,content}){ctx.agents.get(sessionId).followup(llm.createUserMessage({source:{kind:'user',rpcId:requestId},content}));}
 });
 ctx.llm.registerAdapter(['synthetic'],new class extends llm.LlmAdapter{async *stream(options){captured.push(JSON.parse(JSON.stringify(options)));const text=options.messages.findLast(m=>m.source?.kind==='user').content.map(b=>b.text??'').join('');yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Reply '+text}};yield {type:'finish',reason:{kind:'stop'}};}}());
 await ctx.plugin(loop.default,{agents:[]});await ctx.plugin(memory,{});
 fiber=ctx.plugin(bridge,{root:path.join(root,'bridge'),cwd,tokenFile,port,llmModule:pathToFileURL(path.join(sdk,'dsh-llm/lib/index.js')).href});await fiber;
 runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+port,token});
 [childA,childB]=await Promise.all([runtime.openChat(randomUUID()),runtime.openChat(randomUUID())]);
 const runtimes=[runtime,childA,childB],ids=runtimes.map(r=>r.status().modeBindings[0].session_id);assert.equal(new Set(ids).size,3);
 const {ProjectMemory}=await import(pathToFileURL(path.join(path.dirname(memoryEntry),'engine-v4.mjs')).href),savedMemory=new ProjectMemory(process.env.DSH_HOME);
 for(const id of ids)assert.ok(savedMemory.checkpoint(ctx.agents.get(id).session,'SHARED_PROJECT_SENTINEL'));
 for(let i=0;i<ids.length;i++)ownMemory.set(ids[i],'OWN_MEMORY_'+i);
 for(let i=0;i<runtimes.length;i++){
  const status=await runtimes[i].bridgeStatus();assert.equal(status.workspace.id,workspaces[0].id);assert.equal(status.workspace.path,cwd);assert.equal(status.workspace.title,'Chatagent');assert.equal(status.workspace.attached,true);
  await runtimes[i].reply({id:'shared-fixture-'+i,text:'PRIVATE_CHAT_'+i,mode:'social',policy:{allowedTools:[],topicSummaryEnabled:false}});
 }
 await childA.reply({id:'shared-fixture-followup',text:'PRIVATE_CHAT_1_FOLLOWUP',mode:'social',policy:{allowedTools:[],topicSummaryEnabled:false}});
 for(const request of captured){const index=ids.indexOf(request.sessionId);assert.ok(index>=0);const serialized=JSON.stringify(request.messages);assert.match(serialized,new RegExp('OWN_MEMORY_'+index));assert.doesNotMatch(serialized,/SHARED_PROJECT_SENTINEL/);for(let other=0;other<3;other++)if(other!==index)assert.doesNotMatch(serialized,new RegExp('PRIVATE_CHAT_'+other+'|OWN_MEMORY_'+other));}
 const provider=ctx.systemPrompt.layers.global.contexts.get('project-memory');for(const id of ids)assert.equal(provider.text({agent:ctx.agents.get(id)}),'');
 assert.equal(workspaces[0].sessionIds.length,3);assert.equal(fs.existsSync(path.join(cwd,'conversations')),false);
 const diagnostics=JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME,'project-memory/diagnostics.json'),'utf8'));assert.equal(diagnostics.checkpoints,0);
 await new Promise(resolve=>setTimeout(resolve,1100));
 await childA.retire();assert.equal((await childA.bridgeStatus()).retired,true);assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(ids[1]));assert.ok(!workspaces[0].sessionIds.includes(ids[1]));assert.ok(workspaces[0].sessionIds.includes(ids[0]));assert.ok(workspaces[0].sessionIds.includes(ids[2]));
 await assert.rejects(childA.reply({id:'deleted-must-not-run',text:'deleted',mode:'social'}),/CHAT_DELETED/);
 await runtime.retire();assert.equal((await runtime.bridgeStatus()).retired,true);assert.ok(!workspaces[0].sessionIds.includes(ids[0]));assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(ids[0]));
 await childB.reply({id:'surviving-child',text:'SURVIVING_CHAT',mode:'social',policy:{allowedTools:[],topicSummaryEnabled:false}});
 const retiredRoot=path.join(root,'bridge','retired.json');assert.ok(fs.existsSync(retiredRoot));
 const childIdA=fs.readdirSync(path.join(root,'bridge/conversations')).find(id=>JSON.parse(fs.readFileSync(path.join(root,'bridge/conversations',id,'identity.json'),'utf8')).sessionId===ids[1]);
 await childA.close();await childB.close();await runtime.close();await fiber.dispose();
 // Simulate leftovers made by the earlier Chatagent deletion behavior.
 workspaces[0].sessionIds.push(ids[1]);await ctx.workspaceRegistry.archiveSession(ids[0]);
 fiber=ctx.plugin(bridge,{root:path.join(root,'bridge'),cwd,tokenFile,port,llmModule:pathToFileURL(path.join(sdk,'dsh-llm/lib/index.js')).href});await fiber;
 runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+port,token});assert.equal((await runtime.bridgeStatus()).retired,true);
 assert.ok(!workspaces[0].sessionIds.includes(ids[0]));assert.ok(!workspaces[0].sessionIds.includes(ids[1]));assert.deepEqual(workspaces[0].sessionIds,[ids[2]]);
 childA=await runtime.openChat(childIdA);assert.equal((await childA.bridgeStatus()).retired,true);assert.ok(!workspaces[0].sessionIds.includes(ids[1]));
 assert.ok(await ctx.get('sessionPersistence').stat(ids[0]));assert.ok(await ctx.get('sessionPersistence').stat(ids[1]));
 console.log(JSON.stringify({passed:true,installedDshSdk:true,installedProjectMemoryPlugin:true,workspaces:workspaces.length,chats:ids.length,modelCalls:captured.length,projectMemoryCheckpoints:diagnostics.checkpoints,externalCalls}));
}finally{await childA?.close();await childB?.close();await runtime?.close();await fiber?.dispose();await ctx.fiber.dispose();}

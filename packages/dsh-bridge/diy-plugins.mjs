import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {createDiyPlugins,localDay,pluginDefinitions} from '../diy-plugins/runtime.mjs';
import {createMediaSource} from '../diy-plugins/media-source.mjs';
import {markPluginTool} from './tool-catalog.mjs';
import {windowPolicy} from '../conversation/window-policy.mjs';
import {BrowsingArchive} from '../companion-capabilities/vendor/bili/archive.mjs';

export function localChatProfile(config){
 const file=config.mediaOptions?.attachmentsRoot?path.join(path.dirname(config.mediaOptions.attachmentsRoot),'chat.sqlite'):null;if(!file||!fs.existsSync(file))return null;
 const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare("SELECT value FROM settings WHERE key='preferences'").get();if(!row)return null;const p=JSON.parse(row.value),persona=p.personas.find(r=>r.id===p.modes.social.personaId);return {name:p.modes.social.name,persona,windowPolicy:windowPolicy(p.policy),capabilities:p.capabilities??[],toolGrants:Object.fromEntries(db.prepare("SELECT value FROM settings WHERE key LIKE 'session-tools:%'").all().map(r=>{const v=JSON.parse(r.value);return [v.sessionId,v.allowedTools];})),lastChat:db.prepare("SELECT MAX(created_at) at FROM messages WHERE role='user'").get().at??0};}finally{db.close();}
}

function legacyMedia(workspace){
 if(!workspace)return [];const file=path.join(workspace,'companion.json');if(!fs.existsSync(file))return [];
 const capsule=JSON.parse(fs.readFileSync(file,'utf8'));if(!/^[a-f0-9]{64}$/.test(capsule.account??'')||typeof capsule.key!=='string')throw Error('PLUGIN_ARCHIVE_SCOPE_INVALID');
 const folder=path.join(workspace,'state/capability-archive/archive/state/accounts',capsule.account,'bili-archive');if(!fs.existsSync(folder))return [];
 return new BrowsingArchive(folder,{account:capsule.account,session:capsule.key}).list().map(r=>({kind:'context',metadata:{plugin:'media-browser',title:r.title,bvid:r.bvid,provenance:r.provenance,readPages:r.readPages,totalPages:r.totalPages},sourceId:'Chatagent 迁入档案',id:r.id,at:Date.parse(r.at),text:r.feeling}));
}

function legacyDiaries(workspace){
 if(!workspace||!fs.existsSync(path.join(workspace,'companion.json')))return new Map();
 const capsule=JSON.parse(fs.readFileSync(path.join(workspace,'companion.json'),'utf8'));
 if(!/^[a-f0-9]{64}$/.test(capsule.account??'')||typeof capsule.key!=='string')throw Error('PLUGIN_ARCHIVE_SCOPE_INVALID');
 const folder=path.join(workspace,'state/fish-notebook',capsule.account,createHash('sha256').update(capsule.key).digest('hex')),rows=new Map();
 if(fs.existsSync(folder))for(const file of fs.readdirSync(folder).filter(n=>n.endsWith('.json'))){const r=JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));if(r.accountScope===capsule.account&&r.conversationKey===capsule.key)rows.set(file.slice(0,-5),{date:r.date,personaName:r.personaName,sourceCount:r.sourceCount,createdAt:r.createdAt});}
 return rows;
}

function musicRecords(root){
 if(!root)return [];const bindingFile=path.join(root,'chatagent-binding.json');if(!fs.existsSync(bindingFile))return [];
 const binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
 if(!/^[a-f0-9]{64}$/.test(binding.account??'')||!/^wechat:private:[1-9]\d*$/.test(binding.key??''))throw Error('PLUGIN_ARCHIVE_SCOPE_INVALID');
 const file=path.join(root,'state/accounts',binding.account,'media-experiences',createHash('sha256').update(binding.key).digest('hex')+'.sqlite');if(!fs.existsSync(file))return [];
 const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare("SELECT data FROM experiences WHERE kind='music' ORDER BY at LIMIT 5000").all().map(row=>{const r=JSON.parse(row.data);return {kind:'context',id:r.id,sourceId:'音乐记录',at:Date.parse(r.at),text:r.feeling||'已保存听取记录，尚未写下感受',metadata:{plugin:'media-browser',title:r.title,bvid:r.bvid,mediaKind:'music'}};});}finally{db.close();}
}

export function connectDiyPlugins({ctx,agent,config,llm,imported,publish}){
 const root=path.join(config.root,'plugins'),chatFile=config.mediaOptions?.attachmentsRoot?path.join(path.dirname(config.mediaOptions.attachmentsRoot),'chat.sqlite'):null;
 const readChat=fn=>{if(!chatFile||!fs.existsSync(chatFile))return null;const db=new DatabaseSync(chatFile,{readOnly:true});try{return fn(db);}finally{db.close();}};
 const persona=()=>readChat(db=>{const row=db.prepare("SELECT value FROM settings WHERE key='preferences'").get();if(!row)return null;const settings=JSON.parse(row.value),p=settings.personas.find(p=>p.id===settings.modes.social.personaId);return p?{name:p.name,text:p.text}:null;})??{name:'小鲸鱼',text:imported()?.persona??''};
 const history=day=>{
  const local=readChat(db=>db.prepare("SELECT id,role,text,created_at FROM messages WHERE state='completed' ORDER BY seq DESC LIMIT 500").all())??[];
  const rows=[...(imported()?.records??[]).filter(r=>r.kind==='message').map(r=>({...r,created_at:r.at})),...local];
  return [...new Map(rows.filter(r=>Number.isFinite(r.created_at)&&localDay(r.created_at)===day).map(r=>[JSON.stringify([r.id,r.role,r.text]),r])).values()].sort((a,b)=>a.created_at-b.created_at).slice(-100).map(r=>({role:r.role,text:r.text.slice(0,2000)})).reduce((out,r)=>out.reduce((n,v)=>n+v.text.length,0)+r.text.length<=14000?[...out,r]:out,[]);
 };
 const mediaSource=createMediaSource({root:path.join(root,'media-cache'),python:config.diyOptions?.python,asrRoot:config.mediaOptions?.asrRoot});
 const generate=async({prompt,images=[],signal,maxTokens=1800,maxChars=3000,onUsage})=>{
  if(!llm)throw Error('PLUGIN_MODEL_UNAVAILABLE');
  const selection=ctx.get('sessionController')?.agents.selectionFor?.(agent)?.current??agent.session.requestHeader()?.config??agent.options;
  if(!selection?.provider||!selection?.model)throw Error('PLUGIN_MODEL_UNAVAILABLE');
  const service=ctx.get('llm'),content=[{type:'text',text:prompt}];
  if(images.length){const attachments=ctx.get('attachments');if(!attachments)throw Error('PLUGIN_IMAGES_UNAVAILABLE');const info=await service.resolveModelInfo(selection.provider,selection.model,signal);if(!info.inputModalities?.includes('image'))throw Error('PLUGIN_MODEL_VISION_REQUIRED');for(const data of images){signal.throwIfAborted();content.push({type:'image',attachment:await attachments.saveImage({data,mediaType:'image/jpeg',name:'视频抽帧.jpg'})});}}
  const assembler=new llm.BlockAssembler();let length=0;
  for await(const chunk of service.stream({provider:selection.provider,model:selection.model,...selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{},sessionId:'chatagent-plugin-'+randomUUID(),messages:[llm.createUserMessage({source:{kind:'chatagent-plugin'},content})],tools:[],maxTokens,signal})){signal.throwIfAborted();assembler.push(chunk);if(chunk.type==='text-delta'){length+=chunk.text.length;if(length>maxChars)throw Error('PLUGIN_OUTPUT_INVALID');}}
  if(assembler.finish?.kind!=='stop')throw Error('PLUGIN_OUTPUT_INCOMPLETE');onUsage?.(assembler.usage);return assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('').trim();
 };
 const oldMedia=legacyMedia(config.diyOptions?.legacyWorkspace),oldDiaries=legacyDiaries(config.diyOptions?.legacyWorkspace);
 const runtime=createDiyPlugins({root,sessionId:agent.session.id,generate,persona,history,mediaSource,publish,imported:()=>[...(imported()?.records??[]).map(r=>r.kind==='diary'?{...r,metadata:{...r.metadata,...oldDiaries.get(r.id)}}:r),...oldMedia,...musicRecords(config.localPluginsRoot)],busy:()=>agent.status!=='idle',lastChat:()=>readChat(db=>db.prepare("SELECT MAX(created_at) at FROM messages WHERE role='user'").get().at)??0}),disposers=[];
 for(const [id,name,description] of [['fish-notebook','chatagent_notebook__ask','查看当前 Chatagent 对话的鱼的记事本。前两次害羞回应，第三次分享当天日记。'],['media-browser','chatagent_media__browse','在当前 Chatagent 对话中浏览 B 站视频，提取抽帧和语音文字并保存感受。仅在用户要求时调用；input 可为 BV 号或 B 站视频链接，留空由人格选择推荐视频。']]){
  const definition={name,description,parameters:{type:'object',properties:id==='media-browser'?{input:{type:'string',maxLength:300}}:{},additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text']},render:(_,result)=>[{type:'text',text:result.text}]},async execute(args,exec){const requestId='tool-'+String(exec?.rootCallId??exec?.callId??randomUUID()).replace(/[^\w-]/g,'').slice(0,140);const job=runtime.start(id,{requestId,action:id==='fish-notebook'?'ask':'run',input:args.input??'',fromTool:true});await runtime.settled(id);const result=runtime.readJob(job.id);if(result.state!=='completed')return {text:'插件未完成：'+(result.body.error??result.state)};const record=runtime.status(id)[0].records.find(r=>r.id===result.body.recordId);return {text:result.body.answer??record?.text??'记录已保存'};}};
  disposers.push(agent.ctx.tools.register(markPluginTool(definition,pluginDefinitions.find(p=>p.id===id))));
 }
 return {...runtime,generate,async close(){await runtime.close();for(const dispose of disposers)dispose();}};
}

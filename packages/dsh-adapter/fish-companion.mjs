import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fishAdmin } from './fish-admin.mjs';
import { copyTree } from '../migration/runtime-backup.mjs';
// 空白档案只装入用户明确提供的鱼引擎，不发现或复制旧账号资料。
export async function createFishCompanion({root,fishRoot,persona='你是一位友善的中文助手。',now=Date.now}) {
  const engineRoot=path.join(root,'fish-engine');
  if(!fs.existsSync(engineRoot)) {
    if(!fishRoot || !path.isAbsolute(fishRoot))throw Error('FISH_ENGINE_PATH_REQUIRED');
    const pkg=JSON.parse(fs.readFileSync(path.join(fishRoot,'package.json'),'utf8'));
    if(pkg.name!=='dsh-fish-memory'||pkg.version!=='1.5.0'||!fs.existsSync(path.join(fishRoot,'LICENSE')))throw Error('FISH_ENGINE_INVALID');
    fs.mkdirSync(root,{recursive:true});copyTree(fishRoot,engineRoot);
    const entry=path.join(engineRoot,'lib/index.js'),text=fs.readFileSync(entry,'utf8');
    if(!/^const CFG_DIR = .+$/m.test(text))throw Error('FISH_ENGINE_LAYOUT_UNSUPPORTED');
    fs.writeFileSync(entry,text.replace(/^const CFG_DIR = .+$/m,"const CFG_DIR = fileURLToPath(new URL('../../state/fish-home/', import.meta.url))"));
    fs.writeFileSync(path.join(engineRoot,'CHATAGENT-MODIFICATIONS.txt'),'来源：'+pkg.repository?.url+'\n原作者：Yuuyuko-uu\n本地适配：记忆目录绑定到此独立工作区；未启用上游网页、后台任务及更新服务。\n');
  }
  const memory=await import(pathToFileURL(path.join(engineRoot,'lib/index.js')).href),id='chatagent-personal',admin=fishAdmin(memory,id,root);
  let turn=null,context='';const tool=memory.makeRememberTool({});
  const parameters={type:'object',properties:Object.fromEntries(Object.entries(tool.parameters).map(([k,{required,...v}])=>[k,v])),required:Object.entries(tool.parameters).filter(([,v])=>v.required).map(([k])=>k),additionalProperties:false};
  return {
    windowManaged:false,importMemory:value=>{if(turn)throw Error("COMPANION_BUSY");return admin.migrate(value);},memorySettings:admin.read,saveMemorySettings:value=>{if(turn)throw Error('COMPANION_BUSY');return admin.save(value);},historyRecords:()=>[],
    beforeTurn(request){turn=request;const data=memory.loadStore(id);context=admin.enabled()?memory.render(memory.recall(data,request.text,now(),id).selected,now(),memory.selfNameOf(id)):'';},
    setup(ctx){ctx.systemPrompt.section({name:'chatagent:persona',order:100,interpolate:false,text:()=>turn?.persona?.text??persona});ctx.systemPrompt.context({name:'chatagent:memory',order:900,required:true,interpolate:false,text:()=>context});ctx.tools.register({...tool,parameters,execute:args=>{if(!turn)throw Error('COMPANION_TURN_REQUIRED');return admin.enabled()?tool.execute(args,{agent:{session:{id}}}):{ok:false,message:'记忆已暂停'};}});},
    prepareSurface(){},record(){},afterTurn(){turn=null;context='';},afterReply(){},attachDelivery(){},capabilities:{cancel(){}},
    status(){const data=memory.loadStore(id);return {kind:'fish-companion',memories:data.memories.length,deletedMemories:data.deleted.length,historyRecords:0,plugins:[],externalModel:false};},
    archive(kind,offset=0){const data=memory.loadStore(id);return {entries:kind==='memories'?data.memories.slice(offset,offset+50):[],total:kind==='memories'?data.memories.length:0};},
    async checkpoint(destination){copyTree(root,destination);},async close(){}
  };
}

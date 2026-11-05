// Display metadata only; authorization remains an explicit per-session tool allowlist.
const originsKey=Symbol.for('chatagent.tool-origins.v1');
const ownedPluginDefinitions=new WeakMap();
export function markPluginTool(definition,plugin){ownedPluginDefinitions.set(definition,plugin);return definition;}
const wechatOriginsKey=Symbol.for('wechatagent.tool-origins.v1');
export const localized=value=>typeof value==='string'?value: value?.['zh-CN']??value?.['zh-cn']??value?.zh??value?.en??'';
const packageOf=module=>{
  if(module?.startsWith('file:')){try{return decodeURIComponent(new URL(module).pathname).match(/\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//)?.[1]??'';}catch{return '';}}
  return module?.match(/^(@[^/:]+\/[^/]+|[^/:]+)(?:\/|$)/)?.[1]??'';
};
// Compatibility for tools registered before the provenance observer was installed.
// Used only when the corresponding plugin is actually present in DSH's inventory.
const legacy={remember:'dsh-fish-memory',send_meme:'dsh-meme',learn_meme:'dsh-meme','meme-search__search':'dsh-social-bridge-plugin',wechat_hearing__listen:'dsh-social-bridge-plugin',wechat_music__listen:'dsh-social-bridge-plugin',wechat_singing__control:'dsh-social-bridge-plugin',purge_status:'dsh-purge',purge_apply:'dsh-purge',purge_revert:'dsh-purge',purge_audit:'dsh-purge',antigravity_image_generate:'dsh-gemini-pool',antigravity_read_image:'dsh-gemini-pool',codex_image_generate:'dsh-codex-subscription',ops_bash:'dsh-ops',ops_glob:'dsh-ops',ops_grep:'dsh-ops',ops_read_files:'dsh-ops',ops_inspect_local_file:'dsh-ops',ops_result:'dsh-ops'};

export function observeToolOrigins(ctx){
  const root=ctx.root??ctx;
  // Reuse the existing read-only provenance records without replacing its accessor.
  if(root[wechatOriginsKey]||root[originsKey])return ()=>{};
  const definitions=new WeakMap(),tools=ctx.get('tools');
  if(!ctx.reflect?.accessor||!tools)return ()=>{};
  let dispose;
  try{dispose=root.reflect.accessor('tools.register',{get(receiver){
    receiver??=tools;
    const caller=receiver.ctx,method=Reflect.get(Object.getPrototypeOf(receiver),'register');
    return function(definition,...rest){
      const result=Reflect.apply(method,receiver,[definition,...rest]);
      try{let fiber=caller?.fiber;const visited=new Set();while(fiber&&!visited.has(fiber)){visited.add(fiber);const entry=fiber.entry;if(entry?.options?.name){definitions.set(definition,{entryId:String(entry.id??''),moduleName:entry.options.name});break;}fiber=fiber.parent?.fiber;}}catch{}
      return result;
    };
  }});}catch{return ()=>{};}
  const state={definitions};root[originsKey]=state;
  return ()=>{if(root[originsKey]===state)delete root[originsKey];dispose();};
}

export function classifyTool(tool,origin,inventory,bundles){
  if(['chatagent_history_search','chatagent_send_message','chatagent_send_voice'].includes(tool.name))return {...tool,source:'chatagent-dsh-bridge',sourceKind:'internal',provenance:'bridge-owned'};
  // Tools registered through agent.ctx inherit the agent-loop fiber, not their real plugin.
  if(['@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-session-controller'].includes(origin?.moduleName))origin=undefined;
  let record=origin,provenance=origin?'registration':'unknown';
  if(!record&&legacy[tool.name]){
    const expected=legacy[tool.name];
    const matches=inventory.filter(row=>row.enabled&&(
      packageOf(row.moduleName)===expected||row.moduleName?.startsWith('file:')&&decodeURI(row.moduleName).split(/[/?]/).includes(expected)
    ));
    if(matches.length){record=matches.find(row=>row.moduleName===expected)??matches[0];provenance='compatibility';}
  }
  if(!record)return {...tool,sourceKind:'unknown',provenance};
  const rows=b=>Array.isArray(b.rows)?b.rows:[];
  let candidates=bundles.filter(b=>rows(b).some(r=>r.entryId&&r.entryId===record.entryId));
  if(!candidates.length)candidates=bundles.filter(b=>rows(b).some(r=>r.moduleName===record.moduleName));
  if(candidates.length>1){
    if(candidates.every(b=>b.availability==='installation'))return {...tool,source:record.moduleName,sourceKind:'builtin',provenance};
    return {...tool,sourceKind:'unknown',provenance:'ambiguous'};
  }
  const bundle=candidates[0],item=inventory.find(r=>r.entryId===record.entryId)??inventory.find(r=>r.moduleName===record.moduleName);
  const pkg=packageOf(record.moduleName),source=bundle?.name||pkg||(provenance==='compatibility'?legacy[tool.name]:'entry:'+record.entryId);
  const internal=record.moduleName?.includes('/packages/dsh-bridge/')||record.moduleName==='chatagent-dsh-bridge';
  const builtin=bundle?.availability==='installation'||(!bundle&&record.moduleName?.startsWith('@deepseek-ai/'))||record.moduleName?.startsWith('cordis:');
  return {...tool,source,sourceKind:internal?'internal':builtin?'builtin':'plugin',pluginTitle:localized(bundle?.meta?.title)||localized(item?.meta?.title)||source,pluginDescription:localized(bundle?.meta?.description)||localized(item?.meta?.description)||bundle?.description||'',provenance};
}

export async function describeTools(ctx,scope,inventory=[]){
  const registry=ctx.get('tools'),root=ctx.root??ctx;let bundles=[];
  try{const result=await ctx.get('pluginManager')?.listBundles?.();if(Array.isArray(result))bundles=result;}catch{}
  return registry.schemas(scope).map(schema=>{
    let origin;try{const definition=registry.get(schema.name,scope),plugin=ownedPluginDefinitions.get(definition);if(plugin)return {name:schema.name,description:schema.description??'',source:plugin.id,pluginTitle:plugin.name,sourceKind:'plugin',provenance:'plugin-registration'};origin=root[originsKey]?.definitions.get(definition)??root[wechatOriginsKey]?.definitions.get(definition);}catch{}
    return classifyTool({name:schema.name,description:schema.description??''},origin,inventory,bundles);
  });
}

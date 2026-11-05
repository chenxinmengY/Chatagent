import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyTool} from '../packages/dsh-bridge/tool-catalog.mjs';
import {catalogTool} from '../apps/web/tool-catalog.js';

test('new plugins are grouped from registration identity and localized DSH metadata, not tool prefixes',()=>{
 const origin={entryId:'custom:weather',moduleName:'new-user-addon/tools'};
 const bundle={name:'new-user-addon',availability:'profile',meta:{title:{zh:'我的天气'},description:{zh:'查询天气'}},rows:[origin]};
 const result=classifyTool({name:'unrelated_lookup',description:'查询指定城市天气'},origin,[],[bundle]);
 assert.equal(result.sourceKind,'plugin');assert.equal(result.source,'new-user-addon');
 assert.equal(catalogTool(result).plugin,'我的天气');assert.equal(catalogTool(result).explanation,'查询指定城市天气');
});
test('builtins and Chatagent infrastructure are not user plugins; unconfirmed and ambiguous tools stay unconfirmed',()=>{
 assert.equal(classifyTool({name:'subagent'},{moduleName:'@deepseek-ai/dsh-tool-subagent'},[],[]).sourceKind,'builtin');
 assert.equal(classifyTool({name:'internal'},{moduleName:'file:///app/packages/dsh-bridge/index.mjs'},[],[]).sourceKind,'internal');
 assert.equal(classifyTool({name:'remember'},null,[],[]).sourceKind,'unknown');
 const origin={moduleName:'shared-module',entryId:'shared'};
 assert.equal(classifyTool({name:'lookup'},origin,[],[{name:'a',rows:[origin]},{name:'b',rows:[origin]}]).sourceKind,'unknown');
 const old=classifyTool({name:'remember'},null,[{enabled:true,moduleName:'dsh-fish-memory',entryId:'memory'}],[]);
 assert.equal(old.sourceKind,'plugin');assert.equal(old.provenance,'compatibility');
 const scoped=classifyTool({name:'remember'},{moduleName:'@deepseek-ai/dsh-agent-loop'},[{enabled:true,moduleName:'dsh-fish-memory',entryId:'memory'}],[]);
 assert.equal(scoped.source,'dsh-fish-memory');assert.equal(scoped.sourceKind,'plugin');
 // A different plugin using a familiar name must not be assigned to fish memory.
 assert.equal(classifyTool({name:'remember'},{moduleName:'my-other-plugin',entryId:'other'},[],[]).source,'my-other-plugin');
});
test('file-based plugins use exact entry identity and official user-installed bundles remain visible',()=>{
 const origin={moduleName:'file:///custom/entry.mjs',entryId:'local:weather'};
 assert.equal(classifyTool({name:'lookup'},origin,[],[]).source,'entry:local:weather');
 const official={moduleName:'@deepseek-ai/extra-plugin',entryId:'extra'};
 assert.equal(classifyTool({name:'lookup'},official,[],[{name:'official-extra',availability:'profile',rows:[official]}]).sourceKind,'plugin');
});

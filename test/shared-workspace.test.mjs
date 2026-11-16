import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const sdk='D:/dsh/resources/app/dsh/node_modules/@deepseek-ai';
const projectMemory=path.join(os.homedir(),'.dsh/plugins/project-memory/index-v7.mjs');
test('native Chatagent chats share one workspace while transcripts and project memory stay isolated',{
 skip:!fs.existsSync(path.join(sdk,'dsh-agent-loop/lib/index.js'))||!fs.existsSync(projectMemory),timeout:30000,
},()=>{
 const base=path.resolve('.verification-tmp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'shared-workspace-'));
 fs.writeFileSync(path.join(root,'.owned-test-directory'),'synthetic-only');
 try{
  const output=execFileSync(process.execPath,[path.resolve('test/fixtures/shared-workspace-sdk.mjs'),sdk,projectMemory,path.join(root,'run')],{windowsHide:true,timeout:25000,encoding:'utf8',stdio:'pipe'});
  const report=JSON.parse(output.trim().split('\n').at(-1));assert.equal(report.passed,true);assert.equal(report.workspaces,1);assert.equal(report.chats,3);assert.equal(report.externalCalls,0);assert.equal(report.projectMemoryCheckpoints,0);assert.ok(report.modelCalls>=4);
 }finally{
  const resolved=fs.realpathSync(root);if(path.dirname(resolved)!==fs.realpathSync(base)||!path.basename(resolved).startsWith('shared-workspace-')||fs.readFileSync(path.join(resolved,'.owned-test-directory'),'utf8')!=='synthetic-only')throw Error('CLEANUP_BOUNDARY_INVALID');
  fs.rmSync(resolved,{recursive:true});
 }
});

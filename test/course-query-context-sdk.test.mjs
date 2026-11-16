import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const sdk=process.env.CHATAGENT_COURSE_CONTEXT_SDK??'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai';
test('installed native DSH and actual local plugins isolate course queries at the final model boundary',{
 skip:!fs.existsSync(path.join(sdk,'dsh-session-persistence-jsonl/lib/index.js'))||!fs.existsSync('packages/local-user-plugins/plugins/course-query/index.mjs'),timeout:45000,
},()=>{
 const base=path.resolve('.verification-tmp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'course-query-'));
 fs.writeFileSync(path.join(root,'.owned-test-directory'),'synthetic-only');
 try{
  execFileSync(process.execPath,[path.resolve('test/fixtures/course-query-context-sdk.mjs'),sdk,path.join(root,'run')],{windowsHide:true,timeout:40000,stdio:'pipe'});
  const report=JSON.parse(fs.readFileSync(path.join(root,'run/report.json'),'utf8'));
  for(const [key,value] of Object.entries(report))if(typeof value==='boolean')assert.equal(value,!['productionDataWritten','liveBridgeReloaded'].includes(key),key);
  assert.equal(report.externalModelCalls,0);assert.ok(report.syntheticModelCalls>15);assert.ok(report.summaryCalls>0);
 }finally{
  const resolved=fs.realpathSync(root);if(path.dirname(resolved)!==fs.realpathSync(base)||!path.basename(resolved).startsWith('course-query-')||fs.readFileSync(path.join(resolved,'.owned-test-directory'),'utf8')!=='synthetic-only')throw Error('CLEANUP_BOUNDARY_INVALID');
  fs.rmSync(resolved,{recursive:true});
 }
});

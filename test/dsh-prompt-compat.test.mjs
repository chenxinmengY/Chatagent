import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

// Point this at an isolated @deepseek-ai directory containing the official
// 0.2.2-rc.1 SDK. No model credentials or running DSH instance are used.
test('DSH 0.2.2 native turns preserve chat permissions after tools left the prompt callback',{
 skip:!process.env.CHATAGENT_DSH_COMPAT_SDK,
 timeout:30000,
},()=>{
 const temp=mkdtempSync(path.join(tmpdir(),'chatagent-dsh-compat-'));
 try{
  const reportFile=path.join(temp,'report.json');
  execFileSync(process.execPath,[fileURLToPath(new URL('./fixtures/dsh-prompt-compat.mjs',import.meta.url)),process.env.CHATAGENT_DSH_COMPAT_SDK,reportFile],{timeout:25000,stdio:'pipe',windowsHide:true});
  const report=JSON.parse(readFileSync(reportFile,'utf8'));
  assert.deepEqual(report,{sdk:'0.2.2-rc.1',oldFilterErrorReproduced:true,promptCallbackOmitsTools:true,fixedNativeReplies:2,ordinarySessionUnchanged:true,perChatToolPermissionsVerified:true,externalModelCalls:0,syntheticModelCalls:3,productionTouched:false});
 }finally{rmSync(temp,{recursive:true,force:true});}
});

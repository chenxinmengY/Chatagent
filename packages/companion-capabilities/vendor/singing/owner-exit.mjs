import fs from 'node:fs';
import {atomic,read,regular,fileSha} from './common.mjs';
// Called only by the parent's actual ChildProcess close event, after all pipes
// close. The pinned launcher owns a non-inheritable KILL_ON_JOB_CLOSE handle.
export function recordOwnerExit(report,pid) {
  try{
    const proof=read(regular(report));
    if(proof.schema!=='singing-owned-launch-v1'||proof.ownerPid!==pid||proof.killOnOwnerExit!==true)return false;
    atomic(report+'.owner-exit.json',{schema:'singing-owner-exit-v1',ownerPid:pid,reportSha256:fileSha(report),closedAt:Date.now()});return true;
  }catch{return false;}
}
export function ownerHasExited(report) {
  try{
    const proof=read(regular(report));
    if(proof.schema!=='singing-owned-launch-v1'||proof.killOnOwnerExit!==true)return false;
    if(['closed','failed'].includes(proof.state)&&proof.cleanup?.after?.active_processes===0)return true;
    const exit=read(regular(report+'.owner-exit.json'));
    return exit.schema==='singing-owner-exit-v1'&&exit.ownerPid===proof.ownerPid&&exit.reportSha256===fileSha(report)&&Number.isFinite(exit.closedAt);
  }catch{return false;}
}

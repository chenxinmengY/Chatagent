import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertPublicSource} from './source-policy.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const target=path.resolve(process.argv[2]??path.join(root,'artifacts/source','Chatagent-'+pkg.version+'-'+Date.now()));
if(fs.existsSync(target)||target===root||!path.relative(root,target).startsWith('artifacts'+path.sep+'source'+path.sep))throw Error('SOURCE_TARGET_MUST_BE_NEW_ARTIFACT_DIRECTORY');
const files=[];
function collect(dir,prefix){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name),name=prefix+e.name;if(e.isSymbolicLink())throw Error('SOURCE_LINK_REFUSED');if(e.isDirectory())collect(full,name+'/');else if(e.isFile())files.push({full,name});}}
for(const name of ['apps','packages','test'])collect(path.join(root,name),name+'/');
for(const name of ['start-bridge.mjs','start-workspace.mjs','start-standby.mjs','build-android.ps1','build-desktop.ps1','build-region-data.mjs','import-attachments.mjs','restore-runtime-backup.mjs','restore-local-backup.mjs','prepare-source.mjs','source-policy.mjs'])files.push({full:path.join(root,'scripts',name),name:'scripts/'+name});
for(const name of ['package.json','package-lock.json','workspace.example.json','bridge.example.json','.gitignore'])files.push({full:path.join(root,name),name});
if(fs.existsSync(path.join(root,'release')))collect(path.join(root,'release'),'');
else{for(const name of ['README.md','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md'])files.push({full:path.join(root,name),name});collect(path.join(root,'docs'),'docs/');}
if(fs.existsSync(path.join(root,'LICENSE')))files.push({full:path.join(root,'LICENSE'),name:'LICENSE'});
const inventory=[];
const names=new Set(files.map(f=>f.name));if(names.size!==files.length)throw Error('SOURCE_DUPLICATE_PATH');
const privateLiterals=process.env.CHATAGENT_SOURCE_PRIVATE_PATTERNS?JSON.parse(fs.readFileSync(process.env.CHATAGENT_SOURCE_PRIVATE_PATTERNS,'utf8')):[];
for(const f of files.sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  let bytes=fs.readFileSync(f.full);
  if(f.name==='package.json'){
    const value=JSON.parse(bytes);value.scripts=Object.fromEntries(Object.entries(value.scripts).filter(([,command])=>!command.startsWith('node scripts/')||names.has(command.slice(5).split(' ')[0])));value.scripts.test='node --test --test-concurrency=1 test/*.test.mjs';bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
  }
  assertPublicSource(f.name,bytes,{privateLiterals});f.bytes=bytes;
  inventory.push({path:f.name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
fs.mkdirSync(target,{recursive:true});
for(const f of files){const out=path.join(target,...f.name.split('/'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,f.bytes,{flag:'wx'});}
const manifest={format:'chatagent-source-candidate-v1',version:pkg.version,license:pkg.license??'UNLICENSED',publication:'source-snapshot',files:inventory,treeHash:createHash('sha256').update(JSON.stringify(inventory)).digest('hex')};
fs.writeFileSync(path.join(target,'SOURCE-MANIFEST.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({target,files:inventory.length,treeHash:manifest.treeHash,license:manifest.license,publiclyPublished:false}));

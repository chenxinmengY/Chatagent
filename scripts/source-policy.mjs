import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function assertPublicSource(name,bytes,{privateLiterals=[]}={}){
  if(name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||/(?:^|\/)(?:data|private|verification|artifacts|shared-files|node_modules|\.git|\.local-signing)(?:\/|$)|\.private\.|(?:^|\/)\.env(?!\.example$)|\.(?:sqlite(?:-wal|-shm)?|db|key|pem|p12|pfx|jks|apk|idsig|log|zip)$/i.test(name))throw Error('SOURCE_PRIVATE_FILE_REFUSED: '+name);
  if(name.endsWith('.wasm')){
    if(name!=='packages/companion-capabilities/vendor/silk-wasm/lib/silk.wasm'||createHash('sha256').update(bytes).digest('hex')!=='88152af59af535b8056ac806710824b2259a361027451b494f175f48fb39c807')throw Error('SOURCE_UNREVIEWED_BINARY: '+name);
    return;
  }
  const text=bytes.toString('utf8');
  if(bytes.includes(0)||/(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[\w-]{30,}|-----BEGIN (?:[A-Z ]*PRIVATE KEY)|wxid_[a-z0-9]{10,}|[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net|[A-Za-z]:[\\/]+Users[\\/]+[^\s'"\\/]+)/i.test(text)||privateLiterals.some(value=>value.length>=4&&text.includes(value)))throw Error('SOURCE_PRIVATE_CONTENT_REFUSED: '+name);
}

export function auditPublicTree(root,options={}){
  const files=[];
  function visit(dir,prefix=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const name=prefix+entry.name,full=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error('SOURCE_LINK_REFUSED: '+name);
      if(entry.isDirectory())visit(full,name+'/');
      else if(entry.isFile()){const bytes=fs.readFileSync(full);assertPublicSource(name,bytes,options);files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
    }
  }
  visit(root);return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

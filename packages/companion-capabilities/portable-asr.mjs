import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {assertPlain} from '../migration/standby-capture.mjs';
import {verifyAsrInstallation} from './isolated-asr.mjs';

export const asrDownloads=JSON.parse(fs.readFileSync(new URL('./asr-downloads.json',import.meta.url),'utf8'));
const installations=new Map();
const hash=async(file,signal)=>{
  assertPlain(file);const digest=createHash('sha256');
  for await(const chunk of fs.createReadStream(file,{signal}))digest.update(chunk);
  return digest.digest('hex');
};
export async function downloadAsrAsset(asset,cache,{signal,fetchImpl=fetch,progress=()=>{}}={}){
  const file=path.join(cache,asset.sha256+'.download');assertPlain(file);
  if(fs.existsSync(file)&&fs.statSync(file).size===asset.bytes&&await hash(file,signal)===asset.sha256){progress(asset.bytes);return file;}
  if(fs.existsSync(file))fs.unlinkSync(file);
  const temporary=file+'.'+randomUUID()+'.part';let handle;
  try{
    const response=await fetchImpl(asset.url,{redirect:'follow',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(900000)])});
    if(!response.ok||!response.body)throw Error('ASR_SETUP_DOWNLOAD_FAILED');
    const declared=response.headers.get('content-length');if(declared&&Number(declared)!==asset.bytes)throw Error('ASR_SETUP_DOWNLOAD_SIZE');
    handle=await fs.promises.open(temporary,'wx');const digest=createHash('sha256');let received=0;
    for await(const chunk of response.body){signal?.throwIfAborted();received+=chunk.length;if(received>asset.bytes)throw Error('ASR_SETUP_DOWNLOAD_SIZE');digest.update(chunk);await handle.writeFile(chunk);progress(received);}
    await handle.close();handle=null;signal?.throwIfAborted();
    if(received!==asset.bytes||digest.digest('hex')!==asset.sha256)throw Error('ASR_SETUP_DOWNLOAD_HASH');
    fs.renameSync(temporary,file);return file;
  }catch(error){throw Error(signal?.aborted?'ASR_SETUP_CANCELLED':/^ASR_SETUP_/.test(error.message)?error.message:'ASR_SETUP_DOWNLOAD_FAILED');}
  finally{await handle?.close();if(fs.existsSync(temporary)){assertPlain(temporary);fs.unlinkSync(temporary);}}
}

export function extractAsrArchives({root,archives},{signal}={}){
  const script=fs.readFileSync(new URL('./extract-asr.ps1',import.meta.url),'utf8');
  const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve,reject)=>{
    const child=execFile(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,signal,timeout:180000,maxBuffer:65536,encoding:'utf8'},(error,stdout)=>{
      if(error)return reject(Error(signal?.aborted?'ASR_SETUP_CANCELLED':'ASR_SETUP_EXTRACT_FAILED'));
      try{if(JSON.parse(stdout.trim()).completed!==true)throw Error();resolve();}catch{reject(Error('ASR_SETUP_EXTRACT_FAILED'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(Buffer.from(JSON.stringify({root,archives}),'utf8').toString('base64'));
  });
}

async function installationFiles(root,signal){
  const files=[];
  async function walk(folder){assertPlain(folder);for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    signal?.throwIfAborted();const file=path.join(folder,entry.name);assertPlain(file);
    if(entry.isDirectory())await walk(file);
    else if(entry.isFile())files.push({file:path.relative(root,file).replaceAll('\\','/'),bytes:fs.statSync(file).size,sha256:await hash(file,signal)});
    else throw Error('ASR_SETUP_PATH');
  }}
  await walk(root);return files;
}

export class PortableAsr {
  constructor({root,catalog=asrDownloads,fetchImpl=fetch,extract=extractAsrArchives,verify=verifyAsrInstallation,platform=process.platform,arch=process.arch}){
    if(!path.isAbsolute(root))throw Error('ASR_SETUP_PATH');assertPlain(root);
    this.root=root;this.catalog=catalog;this.fetch=fetchImpl;this.extract=extract;this.verify=verify;this.platform=platform;this.arch=arch;
    this.directory=path.join(root,catalog.recipe);this.marker=path.join(root,'.chatagent-managed-asr.json');
    if(!installations.has(root))installations.set(root,{stage:'idle',received:0,total:catalog.files.reduce((n,f)=>n+f.bytes,0),error:null,promise:null});
    this.state=installations.get(root);
  }
  read(){const {promise,...state}=this.state;return {...state,busy:!!promise};}
  async ensure({signal,probe}={}){
    if(this.platform!=='win32'||this.arch!=='x64')throw Error('ASR_SETUP_PLATFORM');
    if(typeof probe!=='function')throw Error('ASR_SETUP_TEST_REQUIRED');
    if(this.state.promise){await this.state.promise;signal?.throwIfAborted();return this.directory;}
    this.state.error=null;this.state.stage='checking';this.state.received=0;
    const job=(async()=>{
      assertPlain(this.root);
      if(fs.existsSync(this.root)&&fs.readdirSync(this.root).length){
        assertPlain(this.marker);if(!fs.existsSync(this.marker)||JSON.parse(fs.readFileSync(this.marker,'utf8')).format!=='chatagent-managed-asr-v1')throw Error('ASR_SETUP_FOREIGN_DIRECTORY');
      }else{fs.mkdirSync(this.root,{recursive:true});fs.writeFileSync(this.marker,JSON.stringify({format:'chatagent-managed-asr-v1'}),{flag:'wx'});}
      assertPlain(this.directory);
      if(fs.existsSync(this.directory)){
        try{this.verify(this.directory);this.state.stage='testing';await probe(this.directory,signal);this.state.stage='ready';return this.directory;}
        catch(error){if(signal?.aborted)throw error;if(!/^(ASR_INSTALLATION_|ASR_ISOLATION_|ENOENT)/.test(error.code??error.message))throw error;
          const manifest=path.join(this.directory,'manifest.json');assertPlain(manifest);
          if(!fs.existsSync(manifest)||JSON.parse(fs.readFileSync(manifest,'utf8')).managedRecipe!==this.catalog.recipe)throw Error('ASR_SETUP_DAMAGED');
          const retired=path.join(this.root,'damaged-'+randomUUID());if(path.dirname(path.resolve(retired))!==path.resolve(this.root))throw Error('ASR_SETUP_PATH');
          fs.renameSync(this.directory,retired);
        }
      }
      const cache=path.join(this.root,'downloads');assertPlain(cache);fs.mkdirSync(cache,{recursive:true});
      const stage=path.join(this.root,'.staging-'+randomUUID());fs.mkdirSync(stage);fs.writeFileSync(path.join(stage,'.owned-asr-stage'),this.catalog.recipe);
      try{
        this.state.stage='downloading';let completed=0;const assets=[];
        for(const asset of this.catalog.files){signal?.throwIfAborted();const file=await downloadAsrAsset(asset,cache,{signal,fetchImpl:this.fetch,progress:n=>{this.state.received=completed+n;}});assets.push({...asset,file});completed+=asset.bytes;}
        this.state.stage='extracting';await this.extract({root:stage,archives:assets.filter(a=>a.kind!=='file')},{signal});signal?.throwIfAborted();
        for(const asset of assets.filter(a=>a.kind==='file')){const target=path.join(stage,asset.target);if(!target.startsWith(stage+path.sep))throw Error('ASR_SETUP_PATH');assertPlain(target);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(asset.file,target,fs.constants.COPYFILE_EXCL);}
        fs.writeFileSync(path.join(stage,'env/Scripts/python313._pth'),'python313.zip\n.\nsite-packages\n');
        fs.copyFileSync(fileURLToPath(new URL('./asr-worker.py',import.meta.url)),path.join(stage,'worker.py'),fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(path.join(stage,'SOURCES.json'),JSON.stringify({recipe:this.catalog.recipe,files:this.catalog.files,credits:{python:'https://www.python.org/',sherpa:'https://github.com/k2-fsa/sherpa-onnx',sensevoice:'https://github.com/FunAudioLLM/SenseVoice',ffmpeg:'https://github.com/imageio/imageio-ffmpeg'}},null,2));
        this.state.stage='verifying';const files=await installationFiles(stage,signal);
        fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify({format:'chatagent-isolated-asr-v1',completed:true,managedRecipe:this.catalog.recipe,model:'sense-voice-int8-2024-07-17',files}));
        this.verify(stage);this.state.stage='testing';await probe(stage,signal);signal?.throwIfAborted();
        if(fs.existsSync(this.directory)){this.verify(this.directory);await probe(this.directory,signal);}
        else fs.renameSync(stage,this.directory);
        this.state.stage='ready';return this.directory;
      }finally{
        if(fs.existsSync(stage)){
          // Delete only this attempt's marked staging directory, never a model selected by the user.
          const resolved=path.resolve(stage);if(path.dirname(resolved)!==path.resolve(this.root)||!path.basename(resolved).startsWith('.staging-'))throw Error('ASR_SETUP_CLEANUP_PATH');
          assertPlain(resolved);if(fs.readFileSync(path.join(resolved,'.owned-asr-stage'),'utf8')!==this.catalog.recipe)throw Error('ASR_SETUP_CLEANUP_PATH');
          await installationFiles(resolved);fs.rmSync(resolved,{recursive:true});
        }
      }
    })();this.state.promise=job;
    try{return await job;}catch(error){this.state.stage='failed';this.state.error=signal?.aborted?'ASR_SETUP_CANCELLED':/^ASR_SETUP_/.test(error.message)?error.message:'ASR_SETUP_FAILED';throw Error(this.state.error);}finally{this.state.promise=null;}
  }
}

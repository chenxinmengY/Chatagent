import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assertPlain} from '../migration/standby-capture.mjs';
import {PortableAsr} from './portable-asr.mjs';
import {createIsolatedAsrProvider,verifyAsrInstallation} from './isolated-asr.mjs';

const manifestHash=root=>{const file=path.join(root,'manifest.json');assertPlain(file);return createHash('sha256').update(fs.readFileSync(file)).digest('hex');};
export class BasicSpeech {
  constructor({voice,root,asrRoot,packageRoot=path.join(root,'voice-runtime'),installer,recognizer=createIsolatedAsrProvider,verify=verifyAsrInstallation}){
    this.voice=voice;this.root=root;this.asrRoot=asrRoot;this.installer=installer??new PortableAsr({root:packageRoot});this.recognizer=recognizer;this.verify=verify;this.providers=new Map();
  }
  get busy(){return this.voice.busy||this.installer.read().busy;}
  selectedRoot(){const selection=this.voice.settings().transcription;return selection?.source==='managed'?this.installer.directory:this.asrRoot;}
  read(){
    const selection=this.voice.settings().transcription,root=this.selectedRoot();let ready=false;
    try{ready=!!selection&&!!root&&manifestHash(root)===selection.manifestHash;}catch{}
    const install=this.installer.read();
    return {...this.voice.read(),basicSpeech:true,asr:{ready,existing:!!this.asrRoot,...install},busy:this.busy};
  }
  async probe(root,file,signal){
    const directory=path.join(this.voice.root,'asr-check-'+randomUUID());fs.mkdirSync(directory);
    try{const result=await this.recognizer({root})({file,directory,signal});if(typeof result.text!=='string'||!/[\p{L}\p{N}]/u.test(result.text))throw Error('ASR_SETUP_TEST_FAILED');}
    catch(error){throw Error(signal?.aborted?'ASR_SETUP_CANCELLED':'ASR_SETUP_TEST_FAILED',{cause:error});}
    finally{const wav=path.join(directory,'input.wav');assertPlain(wav);if(fs.existsSync(wav))fs.unlinkSync(wav);fs.rmdirSync(directory);}
  }
  async setup({source}={}){
    if(source==='existing'||source==='mansui'){await this.voice.setup({source});return this.read();}
    await this.voice.setup({source,prepareTranscription:async({file,signal})=>{
      let root=this.asrRoot,useExisting=false;
      if(root){try{this.verify(root);useExisting=true;}catch{}}
      if(useExisting)await this.probe(root,file,signal);
      else root=await this.installer.ensure({signal,probe:(directory,signal)=>this.probe(directory,file,signal)});
      signal.throwIfAborted();return {source:useExisting?'existing':'managed',manifestHash:manifestHash(root)};
    }});
    return this.read();
  }
  async recognize(request){
    const root=this.selectedRoot();if(!root)throw Error('ASR_NOT_CONFIGURED');
    if(!this.providers.has(root))this.providers.set(root,this.recognizer({root}));
    return this.providers.get(root)(request);
  }
  preview(){return this.voice.preview();}
  close(){return this.voice.close();}
}

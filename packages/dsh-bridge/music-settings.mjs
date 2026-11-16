import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Use the copied music backend's validator, revision and atomic file writer.
export async function connectMusicSettings(root){
 const backend=await import(pathToFileURL(path.join(root,'packages/media-experiences/settings.mjs')).href);
 return {
  read:()=>({settings:backend.readMediaSettings(root).music,revision:backend.mediaSettingsRevision(root)}),
  save(value){
   if(!value||Object.keys(value).some(k=>!['section','settings','revision'].includes(k))||value.section!=='music')throw Error('PLUGIN_SETTINGS_INVALID');
   try{backend.saveMediaSettings(root,{...backend.readMediaSettings(root),music:value.settings},value.revision);}catch(e){throw Error(e.status===409?'PLUGIN_SETTINGS_CHANGED':'PLUGIN_SETTINGS_INVALID');}
   return this.read();
  }
 };
}

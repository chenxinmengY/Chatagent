import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export function isolatedDirectory(value){
 if(typeof value!=='string'||!path.isAbsolute(value))throw Error('MUSIC_ISOLATED_DIRECTORY_REQUIRED');
 const target=path.resolve(value),relative=path.relative(root,target),parts=relative.split(path.sep);
 if(path.isAbsolute(relative)||relative.startsWith('..')||!['state','private-chat'].includes(parts[0]))throw Error('MUSIC_ISOLATED_DIRECTORY_REQUIRED');
 let current=root;for(const part of parts){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('MUSIC_ISOLATED_DIRECTORY_REQUIRED');}
 return target;
}

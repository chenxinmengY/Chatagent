import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Audio sources can exceed 60MiB. Bound the read and digest buffer rather than
// materializing the whole recording merely to verify its existing bytes.
export function fileSha(file) {
  const fd=fs.openSync(regular(file),'r'),digest=crypto.createHash('sha256'),block=Buffer.allocUnsafe(65536);
  try {
    const before=fs.fstatSync(fd);let size=0,count;
    while((count=fs.readSync(fd,block,0,block.length,null))>0){digest.update(block.subarray(0,count));size+=count;}
    const after=fs.fstatSync(fd);
    if(size!==before.size||size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('SINGING_FILE_CHANGED');
    return digest.digest('hex');
  }finally{fs.closeSync(fd);}
}
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch(error) { fs.unlinkSync(temp); throw error; }
}
export function regular(file) {
  const full = path.resolve(file);
  for (let p=full;;p=path.dirname(p)) {
    if(fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('SINGING_LINK_REJECTED');
    if(path.dirname(p)===p) break;
  }
  if(!fs.lstatSync(full).isFile()) throw Error('SINGING_FILE_REQUIRED');
  return full;
}
export function checkedSegments(file) {
  const manifest = read(regular(file));
  if(manifest.ok!==true || manifest.sampleRate!==44100 || !Number.isSafeInteger(manifest.sourceFrames) || manifest.sourceFrames<=0 || !Array.isArray(manifest.segments) || !manifest.segments.length || manifest.segments.length>16) throw Error('SINGING_SEGMENTS_INVALID');
  let cursor=0;
  const parts=manifest.segments.map((part, i)=>{
    if(part.index!==i+1 || part.startFrame!==cursor || !Number.isSafeInteger(part.endFrame) || part.endFrame<=cursor || part.endFrame>manifest.sourceFrames || !/^part-\d\d\.silk$/.test(part.silk??'')) throw Error('SINGING_SEGMENT_COVERAGE');
    cursor=part.endFrame;
    const target=regular(path.join(path.dirname(file),part.silk)), bytes=fs.readFileSync(target);
    if(bytes.length>8*1024*1024 || sha(bytes)!==part.encoded?.sha256 || bytes.length!==part.encoded?.bytes || !bytes.subarray(0,10).equals(Buffer.from('\x02#!SILK_V3','binary'))) throw Error('SINGING_SILK_INTEGRITY');
    let packets=0;
    for(let offset=10;offset<bytes.length;packets++) {
      if(offset+2>bytes.length) throw Error('SINGING_SILK_PACKET');
      const size=bytes.readInt16LE(offset); offset+=2;
      if(size<=0 || offset+size>bytes.length) throw Error('SINGING_SILK_PACKET');
      offset+=size;
    }
    const durationMs=packets*20;
    if(durationMs!==part.encoded.durationMs || durationMs>=60000 || durationMs<=0 || durationMs/1000-(part.endFrame-part.startFrame)/44100<-.0001 || durationMs/1000-(part.endFrame-part.startFrame)/44100>=.02001) throw Error('SINGING_SEGMENT_DURATION');
    return {index:i+1,file:target,sha256:sha(bytes),durationMs,startFrame:part.startFrame,endFrame:part.endFrame};
  });
  if(cursor!==manifest.sourceFrames) throw Error('SINGING_SEGMENT_COVERAGE');
  return {parts,frames:cursor,manifestSha256:sha(fs.readFileSync(file))};
}

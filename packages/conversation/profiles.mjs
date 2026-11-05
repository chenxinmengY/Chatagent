import { inflateSync } from 'node:zlib';
import { fault } from './store.mjs';

const ids = ['self', 'agent'];
const defaults = id => ({ revision: 0, nickname: id === 'self' ? '我' : '小鲸鱼', signature: '', region: '', avatar: '' });
function validate(value) {
  if (!value || Object.keys(value).some(k => !['revision','nickname','signature','region','avatar'].includes(k)) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fault('INVALID_PROFILE',400);
  for (const [key,max] of [['nickname',40],['signature',160],['region',80]]) if (typeof value[key] !== 'string' || value[key].length > max || /[\x00-\x1f\x7f]/.test(value[key]) || key === 'nickname' && !value[key].trim()) throw fault('INVALID_PROFILE',400);
  if (typeof value.avatar !== 'string') throw fault('INVALID_AVATAR',400);
  if (value.avatar) {
    try {
      if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatar) || value.avatar.length > 410000) throw Error();
      const bytes=Buffer.from(value.avatar.split(',')[1],'base64');
      if (!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || bytes.toString('ascii',12,16)!=='IHDR' || bytes.readUInt32BE(8)!==13) throw Error();
      const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20),type=bytes[25];
      if (w!==h || w<1 || w>256 || bytes[24]!==8 || ![2,6].includes(type) || bytes[26] || bytes[27] || bytes[28]) throw Error();
      let offset=8,ended=false;const compressed=[];
      while(offset+12<=bytes.length){const n=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);if(offset+n+12>bytes.length || kind==='acTL')throw Error();if(kind==='IDAT')compressed.push(bytes.subarray(offset+8,offset+8+n));offset+=n+12;if(kind==='IEND'){ended=true;break;}}
      const size=(w*(type===6?4:3)+1)*h;
      if(!ended || offset!==bytes.length || inflateSync(Buffer.concat(compressed),{maxOutputLength:size}).length!==size)throw Error();
    } catch { throw fault('INVALID_AVATAR',400); }
  }
  return {...value,nickname:value.nickname.trim(),signature:value.signature.trim(),region:value.region.trim()};
}
export class Profiles {
  constructor(store){this.store=store;store.db.exec('CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL)');}
  read(id){if(!ids.includes(id))throw fault('INVALID_PROFILE',400);const row=this.store.db.prepare('SELECT data FROM profiles WHERE id=?').get(id);return row?JSON.parse(row.data):defaults(id);}
  list(after){const profiles=Object.fromEntries(ids.map(id=>[id,this.read(id)])),version=ids.map(id=>profiles[id].revision).join('.');return {version,profiles:after===version?null:profiles};}
  save(id,value){if(!ids.includes(id))throw fault('INVALID_PROFILE',400);const clean=validate(value);return this.store.transaction(()=>{if(this.read(id).revision!==clean.revision)throw fault('PROFILE_CHANGED',409);const next={...clean,revision:clean.revision+1};this.store.db.prepare('INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(id,next.revision,JSON.stringify(next));return next;});}
}

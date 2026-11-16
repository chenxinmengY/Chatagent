export const isMusicStop=text=>typeof text==='string'&&(/(?:别|不要|不用|先不|暂不|不想)(?:再|继续)?听|(?:暂停|停止)(?:播放|听歌|音乐|试听)/.test(text)||/^\s*(?:先)?(?:暂停|停止)(?:一下|吧|了)?[。！!]?\s*$/.test(text));
export function explicitRelisten(text){
 if(typeof text!=='string'||text.length>8000||isMusicStop(text)||/引用|转发|他说|她说|假设|示例|没有|没让|不是让|不(?:需要|必|用|要)|是不是|是否|(?:重新|再次|实际|复)听(?:了|过)|[“”「」『』"]/.test(text))return false;
 return /(?:^|[。！？!?,，；;：:\n])\s*(?:(?:那|现在|麻烦你?|请你?|帮我|给我|你|先|只|能不能|能否|能|可不可以|可以)\s*){0,4}(?:再(?:实际)?听|重新听|再次听|实际听|复听)/.test(text);
}
export function invitation(message,{quoted=false,forwarded=false}={}){
 if(typeof message!=='string'||message.length>8000||quoted||forwarded)return null;
 const sources=[...new Set(message.match(/BV[1-9A-HJ-NP-Za-km-z]{10}/g)??[])];if(sources.length!==1)return null;
 if(isMusicStop(message)||/引用|转发|他说|她说|假设|示例/.test(message))return null;
 if(!/一起听|陪我听|听听|给你听|给你分享.*(?:歌|音乐)|分享.*(?:歌|音乐).*(?:听|BV)|听一下|听这首/.test(message))return null;
 return sources[0];
}

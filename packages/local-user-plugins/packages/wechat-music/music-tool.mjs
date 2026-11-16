export const name='cyberwife-music-tool';export const inject=['tools','wechatMusic'];
export const TOOL_NAME='wechat_music__listen';
const fields=['sessionId','accountId','conversationKey','epoch','receivedAt'];
const fail=c=>{throw Error(c);};
export function validateArgs(args,seconds){
 if(!args||typeof args!=='object'||Array.isArray(args)||!['overview','recall','relisten','lyrics'].includes(args.action))fail('MUSIC_ARGUMENTS');
 const expected=args.action==='relisten'?['action','start','end']:args.action==='lyrics'?['action','referenceId']:['action'];
 if(Object.keys(args).length!==expected.length||expected.some(k=>!Object.hasOwn(args,k)))fail('MUSIC_ARGUMENTS');
 if(args.action==='relisten'&&(!Number.isFinite(args.start)||!Number.isFinite(args.end)||args.start<0||args.end>seconds||args.end<=args.start||args.end-args.start>30))fail('MUSIC_RANGE_INVALID');
 if(args.action==='lyrics'&&!/^[a-z0-9-]{1,64}$/.test(args.referenceId??''))fail('MUSIC_REFERENCE_ID');
}
export function registerMusic(ctx,service,{now=Date.now,maxAgeMs=300000}={}){
 if(!service||['bindingForSession','enabled','execute'].some(k=>typeof service[k]!=='function'))fail('MUSIC_SERVICE_REQUIRED');
 return ctx.get('tools').register({
  name:TOOL_NAME,description:'当前私聊的音乐工具。overview读取已选完整真实音轨的大致旋律和歌词主题；relisten仅复听明确起止秒数内的字词（≤30秒）；lyrics用referenceOptions中已核对的同版本参考id辅助校对；recall只读本会话已有音乐记录，停止后仍可用，不重新听、不恢复选曲，多首时先明确是哪首。titleMetadata是页面标题来源，不是独立听音识曲。可拒绝或停止。成功得到观察后，如有自己的感受可调用wechat_media__feeling归档；重要体验再自主考虑已授权remember。工具本身不改人设和长期记忆，无确认结果时不声称听过，不猜歌名。',
  parameters:{type:'object',properties:{action:{type:'string',enum:['overview','relisten','lyrics','recall']},start:{type:'number',minimum:0},end:{type:'number',minimum:0},referenceId:{type:'string'}},required:['action'],additionalProperties:false},timeoutMs:200000,
  output:{schema:{type:'object',properties:{status:{type:'string'},source:{type:'object',properties:{bvid:{type:'string'},cid:{type:'number'}},required:['bvid','cid'],additionalProperties:false},material:{type:'object',additionalProperties:true},untrusted:{type:'boolean'}},required:['status','material','untrusted'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  async execute(args,exec){
   const sid=exec?.agent?.session?.id;if(typeof sid!=='string'||!sid)fail('MUSIC_SESSION_REQUIRED');
   if(args?.action==='recall'&&typeof service.recallForSession==='function'){
    validateArgs(args);exec.signal?.throwIfAborted();const r=await service.recallForSession(sid,{signal:exec.signal});exec.signal?.throwIfAborted();
    if(r?.schema!=='music-history-v1'||r.binding?.sessionId!==sid||!['no_history','ambiguous','context_only'].includes(r.status)||r.untrusted!==true||!r.material||typeof r.material!=='object'||!Array.isArray(r.material.records)||r.material.records.length>3)fail('MUSIC_RESULT_BINDING');
    const value={status:r.status,...(r.source?{source:r.source}:{}),material:r.material,untrusted:true};if(Buffer.byteLength(JSON.stringify(value))>20000)fail('MUSIC_RESULT_SIZE');return value;
   }
   const b=service.bindingForSession(sid);
   const check=()=>{exec.signal?.throwIfAborted();const current=service.bindingForSession(sid);
    if(!b||!current||b.sessionId!==sid||fields.some(k=>current[k]!==b[k])||!Number.isFinite(b.receivedAt)||now()<b.receivedAt||now()-b.receivedAt>maxAgeMs||service.enabled(b)!==true)fail('MUSIC_SCOPE_UNAVAILABLE');};
   check();validateArgs(args,b.source.seconds);const r=await service.execute(b,args,{signal:exec.signal});check();
   if(r?.schema!=='music-material-v1'||r.binding?.sessionId!==sid||fields.slice(0,4).some(k=>r.binding[k]!==b[k])||r.binding?.sourceKey!==`${b.source.bvid}:${b.source.cid}:${b.source.sourceSha256}:${b.source.wholeSha256}`||r.source?.bvid!==b.source.bvid||r.source?.cid!==b.source.cid||!r.untrusted||!r.material||typeof r.material!=='object')fail('MUSIC_RESULT_BINDING');
   const value={status:r.status,source:r.source,material:r.material,untrusted:true};if(JSON.stringify(value).length>20000)fail('MUSIC_RESULT_SIZE');return value;
  },
 });
}
export function apply(ctx,config={}){if(config.enabled===true)registerMusic(ctx,ctx.get('wechatMusic'));}

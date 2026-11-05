// A narrow explicit private-chat trigger. The message still goes through chat.
const begin=/^(?:你)?(?:去|可以去)?刷(?:一会儿|一会|会儿|会)?(?:B站|b站|哔哩哔哩)(?:吧|啦|呀|。|！|!)?$/i;
// Accept a direct invitation with an address and a short follow-on clause.
// Questions and negated invitations remain ordinary conversation.
const addressedBegin=/^(?:[^，,。！？?\r\n]{1,12}[，,]\s*)?(?:你)?(?:先)?(?:去|可以去)刷(?:一会儿|一会|会儿|会)?(?:B站|哔哩哔哩)(?:吧|啦|呀)?(?:[，,。！!][^\r\n]{0,80})?$/i;
const namedBegin=/^[^，,。！？?\r\n]{1,6}你(?:先)?(?:去|可以去)刷(?:一会儿|一会|会儿|会)?(?:B站|哔哩哔哩)(?:吧|啦|呀)(?:[，,。！!][^\r\n]{0,80})?$/i;
const notAnInvitation=/(?:别|不要|不准|不用|停止|暂停|不想|不去|不能|没去|没有|[？?])/;
const stop=/^(?:先)?(?:别|不要|停止|暂停)(?:再)?刷(?:B站|b站|哔哩哔哩)(?:了|吧|。|！|!)?$/i;
// A direct invitation can be one clause of an ordinary message. Keep past,
// quoted, hypothetical and negative speech out of this deterministic trigger.
const directBegin=/^(?:你)?(?:先)?(?:去|可以去)?刷(?:一会儿|一会|会儿|会)?(?:B站|哔哩哔哩)(?:去)?(?:吧|啦|呀)?(?:我(?:先|去|要|得|睡|休息|忙)[^\r\n]{0,80})?$/i;
const reported=/(?:[“”‘’「」『』"`]|(?:^|\n)\s*>|引用|转发|转述|比如|例如|假设|假如|如果|要是|(?:我|你|他|她|有人)(?:说|问|让))/;
export class ManualTrigger{
 constructor({key,bridge}){if(!/^wechat:private:[^:]+$/.test(key))throw Error('INVALID_TRIGGER_SCOPE');this.key=key;this.bridge=bridge;this.pending=null;this.busy=false;this.closed=false;this.inflight=null;this.seen=new Set();}
 receive(message){
  if(this.closed||message?.platform!=='wechat'||message.kind!=='private'||'wechat:private:'+message.conversation_id!==this.key||!message.message_id||message.outgoing||message.quoteReply||message.forwardedRecord||message.quoted||message.forwarded)return false;
  const messageId=String(message.message_id);if(this.seen.has(messageId))return false;
  const text=String(message.text??'').trim().replace(/[ \t]*B[ \t]*站/gi,'B站');if(text.length>500||reported.test(text))return false;
  const clauses=text.split(/[，,。！!；;\r\n]+/).map(x=>x.trim()).filter(Boolean);
  const action=clauses.some(x=>stop.test(x))?'stop':!notAnInvitation.test(text)&&(begin.test(text)||addressedBegin.test(text)||namedBegin.test(text)||clauses.some(x=>directBegin.test(x)))?'start':null;if(!action)return false;
  this.seen.add(messageId);if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value);this.pending=action;return true;
 }
 tick(){
  if(this.closed||this.busy)return Promise.resolve();this.busy=true;
  const work=(async()=>{try{
   if(this.pending){const action=this.pending,result=await this.bridge[action]();if(this.pending===action&&result?.status!=='deferred')this.pending=null;return;}
   await this.bridge.tick();
  }finally{this.busy=false;}})();
  this.inflight=work;work.finally(()=>{if(this.inflight===work)this.inflight=null;}).catch(()=>{});return work;
 }
 async close(){this.closed=true;this.pending=null;await this.inflight;}
}

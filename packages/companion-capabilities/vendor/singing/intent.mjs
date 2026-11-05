const BV=/BV[1-9A-HJ-NP-Za-km-z]{10}/g;
export function stopIntent(text) {
  return typeof text==='string' && !/[“”「」『』"]|引用|转发|他说|她说|假设|示例|如果|假如|倘若|要是|当我|没(?:有)?让|什么意思|这句话|功能|代码|怎么|(?:别|不要|不用|不必|不想)(?:再)?(?:停止|暂停|取消)/.test(text) && /(?:停止|暂停|取消)(?:制作|发送|这首|这次|一下)?(?:唱歌|翻唱|点唱|歌唱)|(?:别|不要|不用|先不)(?:再|继续)?(?:给我)?(?:唱|翻唱)|不想听你唱|^\s*停止唱歌[。！!]?\s*$/.test(text);
}
const unsafe = text => /[“”「」『』"]|引用|转发|他说|她说|假设|示例|如果|假如|倘若|要是|当我|没(?:有)?让|别|不是让|不是想|不想|没想|不(?:可以|允许|需要|必|用|要)|(?:会不会|是否会|会唱.*吗)|为什么|怎么实现|功能|代码|测试用例/.test(text);
function span(text) {
  const time='(\\d+(?:[:：]\\d{2}(?:\\.\\d+)?|\\.\\d+)?(?:\\s*分(?:钟)?(?:\\s*\\d+(?:\\.\\d+)?\\s*秒)?)?)';
  const range=text.match(new RegExp('(?:第)?'+time+'\\s*秒?\\s*[-–—~～至到]\\s*(?:第)?'+time+'\\s*秒?'));
  const seconds=value=>{
    if(/[:：]/.test(value)){const [m,s]=value.split(/[:：]/).map(Number);return s<60?m*60+s:NaN;}
    if(/分/.test(value)){const v=value.match(/^(\d+(?:\.\d+)?)\s*分(?:钟)?(?:\s*(\d+(?:\.\d+)?)\s*秒)?$/);return v?Number(v[1])*60+Number(v[2]??0):NaN;}
    return Number(value);
  };
  if(range)return {start:seconds(range[1]),end:seconds(range[2])};
  const length=text.match(/(?:前\s*)?(\d+(?:\.\d+)?)\s*(秒|分钟?)/);
  if(length)return {start:0,end:Number(length[1])*(length[2]==='秒'?1:60),invalid:/(?:最后|末尾|后)\s*\d/.test(text)};
  return null;
}
export function parseInvitation(row, {proposal,selected,now=Date.now()}={}) {
  const text=row?.text;
  if(row?.outgoing || row?.forwardedRecord || row?.quoteReply || row?.interaction==='pat' || typeof text!=='string' || text.length>4000 || stopIntent(text) || unsafe(text)) return null;
  const createdAt=Number(row.timestamp)*1000;
  if(!row.message_id || !Number.isFinite(createdAt) || createdAt>now+5000 || now-createdAt>90000) return null;
  const remake=/重做一版|重新做一版/.test(text);
  const explicit=/(?:给我唱|唱给我|帮我唱|翻唱|试唱|唱一下|唱一首|唱这首|唱首|唱一段|唱段|想听你唱|想听你.*唱|来一段.*唱|(?:能不能|可不可以|可以|能否).*唱|^\s*唱(?:\s|BV|https?:))/.test(text)||remake;
  const consent=/^\s*(?:好[的呀啊]?|可以|行|嗯|那就|同意)[，,\s]*(?:(?:你)?(?:唱吧|唱|开始吧|开始|来吧|试试吧))?[。！!]?\s*$/.test(text);
  if(!explicit && !(consent && proposal && Number.isFinite(proposal.createdAt) && proposal.createdAt<=now+5000 && now-proposal.createdAt<=300000)) return null;
  const ids=[...new Set(text.match(BV)??[])];
  const requested=span(text);
  const rangeOnly=requested&&/^(?:那就[，,\s]*)?(?:给我|帮我)?(?:翻唱|试唱|唱)(?:一下|一段)?\s*(?:前|第)?[\d\s:：.\-–—~～至到分秒钟]+(?:的片段)?(?:吧|给我听)?[。！!]?\s*$/.test(text);
  const bvid=ids.length===1?ids[0]:ids.length===0?(consent?proposal?.bvid:remake||rangeOnly||/这首|这个版本|刚才那首|刚刚那首/.test(text)?selected?.bvid:null):null;
  let mode=requested||/片段|一段|唱段|试唱|时间段/.test(text)?'clip':consent?(proposal.mode??'whole'):remake?(selected?.mode??'whole'):'whole';
  let start=0,end=25;
  if(requested){start=requested.start;end=requested.end;}
  else if(consent && mode==='clip'){start=proposal.start??0;end=proposal.end??25;}
  else if(remake && mode==='clip'){start=selected.start??0;end=selected.end??25;}
  if(mode==='clip' && (requested?.invalid||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>300||end>300)) return {needsSelection:true,reason:'clip_range',messageId:String(row.message_id),createdAt};
  return {bvid:bvid??null,needsSelection:!bvid,messageId:String(row.message_id),createdAt,mode,...(mode==='clip'?{start,end}:{}),remake:/重做|重新做|再做一版/.test(text)};
}
export function outgoingProposal(rows, now=Date.now()) {
  // Consent is only attached to a proposal actually delivered in this chat.
  for(const row of [...rows].reverse()) {
    if(!row.outgoing) continue;
    if(row.quoteReply||row.forwardedRecord)return null;
    if(row.delivery_status!=='confirmed') return null;
    const text=row.text??'',ids=[...new Set(text.match(BV)??[])];
    if(ids.length!==1 || /[“”「」『』"]|引用|转发|他说|她说|假设|示例|如果|假如|不可以|不想唱|不愿唱|不会唱|不能唱|没说要唱|功能|代码/.test(text) || !/唱|翻唱/.test(text) || !/要不要|想不想|可以.*唱|我.*唱.*(?:吗|好不好|怎么样)|给你唱.*(?:吗|好不好)/.test(text)) return null;
    const createdAt=Number(row.timestamp)*1000;
    const range=span(text);
    if(range&&(range.invalid||!Number.isFinite(range.start)||!Number.isFinite(range.end)||range.start<0||range.end<=range.start||range.end>300))return null;
    return Number.isFinite(createdAt)&&createdAt<=now+5000&&now-createdAt<=300000?{bvid:ids[0],createdAt,mode:range||/一段|片段|试唱/.test(text)?'clip':'whole',...(range?{start:range.start,end:range.end}:{})}:null;
  }
  return null;
}

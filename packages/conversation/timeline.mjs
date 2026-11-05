import { fault } from './store.mjs';
import { recordKey } from '../migration/portable.mjs';
export function timelinePage(store, archive, legacy = [], params = new URLSearchParams()) {
  const q=params.get('q')??'', type=params.get('type')??'', date=params.get('date')??'', cursor=params.get('before');
  if(q.length>200 || !['','image','audio','file'].includes(type) || date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date))throw fault('TIMELINE_QUERY_INVALID',400);
  let before=null;
  if(cursor) { try { before=JSON.parse(Buffer.from(cursor,'base64url').toString()); }catch{throw fault('INVALID_CURSOR',400);} if(!Array.isArray(before)||before.length!==2||!Number.isSafeInteger(before[0])||typeof before[1]!=='string')throw fault('INVALID_CURSOR',400); }
  const imported = [...archive.records().filter(r=>r.kind==='message'),...legacy].map(r=>({id:'import-'+recordKey(r),role:r.role,text:r.text,mode:r.mode??'social',created_at:r.at??0,queued_at:r.at??0,state:'completed',revision:1,attachments:[],source:{sourceId:r.sourceId,scope:r.scope,id:r.id,unknownTime:r.at==null,missingAttachments:r.attachments??[]},seq:0}));
  const live=store.db.prepare('SELECT * FROM messages').all().map(r=>store.hydrate(r));
  let rows=[...new Map([...imported,...live].map(r=>[r.id,r])).values()].filter(r=>!q||r.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  if(date){const start=Date.parse(date+'T00:00:00+08:00');rows=rows.filter(r=>r.created_at>=start&&r.created_at<start+86400000);}
  if(type)rows=rows.filter(r=>[...(r.attachments??[]),...(r.source?.missingAttachments??[])].some(f=>type==='file'?!/^(audio|image)\//.test(f.mediaType):f.mediaType?.startsWith(type+'/')));
  for(const r of rows)r.timeline_order=r.source?r.id:'live-'+String(r.seq).padStart(20,'0')+'-'+r.id;
  rows.sort((a,b)=>b.created_at-a.created_at||(a.timeline_order<b.timeline_order?1:a.timeline_order>b.timeline_order?-1:0));
  if(before)rows=rows.filter(r=>r.created_at<before[0]||r.created_at===before[0]&&r.timeline_order<before[1]);
  const page=rows.slice(0,100),last=page.at(-1);
  return {messages:page.reverse(),hasMore:rows.length>100,nextBefore:last?Buffer.from(JSON.stringify([last.created_at,last.timeline_order])).toString('base64url'):null};
}

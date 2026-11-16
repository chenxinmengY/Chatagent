// Error diagnostics deliberately exclude authentication and project identifiers.
export async function summarizeRejection(response,credential){
 const reader=response.body?.getReader(),chunks=[];let size=0;
 if(reader)try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;
  if(size>65536)throw Error('ERROR_BODY_TOO_LARGE');chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
 const raw=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(raw);}catch{}
 let message=String(data?.error?.message??'');
 for(const v of [credential.token,credential.projectId])if(v)message=message.replaceAll(v,'[redacted]');
 message=message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]')
  .replace(/(?:Bearer\s+|ya29\.)\S+/gi,'[credential]').replace(/[\r\n]+/g,' ').slice(0,400);
 const summary={status:response.status,errorStatus:/^[A-Z_]+$/.test(data?.error?.status??'')?data.error.status:undefined,
  message,retryAfter:response.headers.get('retry-after')??undefined,
  reasons:(data?.error?.details??[]).map(d=>d.reason).filter(v=>typeof v==='string'&&/^[A-Z_]{1,80}$/.test(v)),
  retryDelays:(data?.error?.details??[]).map(d=>d.retryDelay).filter(v=>typeof v==='string'&&/^\d+(?:\.\d+)?s$/.test(v))};
 return {summary,response:new Response(raw,{status:response.status,headers:response.headers})};
}

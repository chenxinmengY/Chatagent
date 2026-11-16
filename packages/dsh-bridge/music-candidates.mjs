// Refresh an exhausted ranking from the public music feed; no account data is read.
export function expandMusicCandidates({ranked,isMusicCandidate,fetcher=fetch}){
 return async({maxSeconds=300,signal,excluded=[]}={})=>{
  const known=new Set(excluded);let primary=[];
  try{primary=await ranked({maxSeconds,signal});}catch(error){signal?.throwIfAborted();}
  const fresh=primary.filter(r=>!known.has(r.bvid));if(fresh.length>=3)return fresh;
  const response=await fetcher('https://api.bilibili.com/x/web-interface/newlist?rid=3&pn=1&ps=30',{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('MUSIC_CANDIDATES_UNAVAILABLE');
  const chunks=[];let bytes=0;try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('MUSIC_CANDIDATES_TOO_LARGE');chunks.push(Buffer.from(chunk));}}finally{await response.body?.cancel().catch(()=>{});}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(result.code!==0||!Array.isArray(result.data?.archives))throw Error('MUSIC_CANDIDATES_INVALID');
  const recent=result.data.archives.filter(r=>!known.has(r.bvid)&&isMusicCandidate(r,maxSeconds)).map(v=>({bvid:v.bvid,title:v.title.slice(0,200),description:String(v.desc??'').slice(0,200),seconds:v.duration,region:String(v.tname??'').slice(0,30)}));
  return [...new Map([...fresh,...recent].map(r=>[r.bvid,r])).values()];
 };
}

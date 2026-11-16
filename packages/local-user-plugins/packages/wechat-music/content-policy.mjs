const musicTypes=new Set([28,29,30,31,59,193,194,265]);
const excluded=/剧本|剧情|短剧|段子|整蛊|恶搞|搞笑|调琴|调音|教学|教程|乐理|讲解|解说|盘点|科普|评测|测评|采访|唠嗑|聊天|路人反应|听歌识曲|introduction\s*film|reaction/iu;
const performance=/翻唱|演唱|弹唱|演奏|弹奏|独奏|合奏|纯音乐|配乐|原创(?:歌曲|音乐|曲)|单曲|新歌|音乐会|演唱会|\b(?:mv|cover|live)\b|《[^》]{1,60}》|【(?:AI|初音|洛天依|VOCALOID)[^】]{0,40}】/iu;
export function musicPerformanceEvidence(title,description=''){
 return typeof title==='string'&&title.length<=256&&typeof description==='string'&&description.length<=2000&&!excluded.test(title+'\n'+description)&&performance.test(title+'\n'+description);
}
export function isMusicCandidate(v,maxSeconds=300){
 return /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(v?.bvid??'')&&musicTypes.has(v.tid)&&v.videos===1&&Number.isFinite(v.duration)&&v.duration>=10&&v.duration<=maxSeconds&&musicPerformanceEvidence(v.title,String(v.desc??'').slice(0,2000));
}

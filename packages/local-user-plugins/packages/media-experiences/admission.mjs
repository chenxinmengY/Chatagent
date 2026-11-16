// Only the authenticated bridge's claimed reading capability can admit a
// scheduled activity. Model text cannot choose a quota origin or track.
export function admitMediaActivity({book,body,readingCapability,settings,now=Date.now()}){
 if(body.autonomousMusic!==undefined){
  const m=body.autonomousMusic;
  if(!readingCapability||!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!['opportunityId','bvid'].includes(k))||typeof m.opportunityId!=='string'||! /^(?:auto|invited)-music-[a-f0-9-]{36}$/.test(m.opportunityId)||body.mediaRoundId!==undefined||body.visualToken!==undefined||body.images?.length||body.voices?.length)throw Error('invalid_music_opportunity');
  const round=book.round(m.opportunityId);
  if(!round||round.category!=='music'||!['autonomous','invited'].includes(round.origin)||round.status!=='active'||now>=Math.min(round.deadline,round.at+settings.music.roundMinutes*60000))throw Error('MUSIC_OPPORTUNITY_CLOSED');
  if(round.origin!=='invited'&&(!settings.music.enabled||(book.usage().times?.find(t=>t.category==='music')?.milliseconds??0)>=settings.music.dailyMinutes*60000))throw Error('MEDIA_DAILY_TIME_LIMIT');
  if(m.bvid!==undefined&&(!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(m.bvid)||body.musicTurn?.invitation?.bvid!==m.bvid||body.musicTurn?.mentions?.length!==1||body.musicTurn.mentions[0]!==m.bvid||body.musicTurn.stop!==false))throw Error('invalid_music_opportunity');
  if(m.bvid===undefined&&body.musicTurn!==undefined)throw Error('invalid_music_opportunity');
  return {music:m.bvid?{id:round.id,origin:round.origin}:null};
 }
 if(readingCapability||body.mediaRoundId!==undefined){
  if(!readingCapability||!/^[a-f0-9-]{36}$/.test(body.mediaRoundId??''))throw Error('invalid_media_round');
  const round=book.round(body.mediaRoundId);
  if(!round||round.category!=='video'||round.status!=='active'||now>=Math.min(round.deadline,round.at+settings.video.roundMinutes*60000))throw Object.assign(Error('MEDIA_ROUND_CLOSED'),{admitted:false});
  if(round.origin!=='invited'){
   const u=book.usage();
   if(!settings.video.enabled||(u.times?.find(t=>t.category==='video')?.milliseconds??0)>=settings.video.dailyMinutes*60000)throw Object.assign(Error('MEDIA_DAILY_TIME_LIMIT'),{admitted:false});
   if(u.tokens+80000>settings.video.tokenLimit)throw Object.assign(Error('MEDIA_TOKEN_LIMIT'),{admitted:false});
  }
 }
 return {music:null};
}

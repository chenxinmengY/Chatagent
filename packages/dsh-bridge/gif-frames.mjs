// Preserve the original GIF for delivery; give the image model an ordered,
// timestamped storyboard covering one animation cycle in a single image slot.
export async function gifStoryboard(bytes,sharp){
  const options={failOn:'none',limitInputPixels:64000000},meta=await sharp(bytes,options).metadata();
  const totalFrames=meta.pages??1,count=Math.min(12,totalFrames),indices=Array.from({length:count},(_,i)=>count===1?0:Math.round(i*(totalFrames-1)/(count-1)));
  let durationMs=0;const times=[];
  for(let i=0;i<totalFrames;i++){times.push(durationMs);const delay=meta.delay?.[i];durationMs+=Number.isFinite(delay)&&delay>0?Math.max(20,delay):100;}
  const cellWidth=384,cellHeight=320,labelHeight=26,columns=Math.min(4,count),rows=Math.ceil(count/columns),parts=[],frames=[];
  for(const [order,index]of indices.entries()){
    const data=await sharp(bytes,{...options,page:index,pages:1}).resize(cellWidth,cellHeight,{fit:'contain',background:'#ffffff',withoutEnlargement:true}).flatten({background:'#ffffff'}).png().toBuffer();
    const left=order%columns*cellWidth,top=Math.floor(order/columns)*(cellHeight+labelHeight),timeMs=times[index];
    parts.push({input:data,left,top:top+labelHeight});frames.push({index,timeMs});
    const label=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#edf2f8"/><text x="10" y="18" font-family="sans-serif" font-size="15" fill="#172b45">${order+1}/${count}   ${(timeMs/1000).toFixed(2)}s   frame ${index+1}/${totalFrames}</text></svg>`);
    parts.push({input:label,left,top});
  }
  const width=columns*cellWidth,height=rows*(cellHeight+labelHeight),borders=frames.map((_,i)=>`<rect x="${i%columns*cellWidth+0.5}" y="${Math.floor(i/columns)*(cellHeight+labelHeight)+0.5}" width="${cellWidth-1}" height="${cellHeight+labelHeight-1}" fill="none" stroke="#8d9bad"/>`).join('');
  parts.push({input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${borders}</svg>`),left:0,top:0});
  const data=await sharp({create:{width,height,channels:3,background:'#ffffff'}}).composite(parts).jpeg({quality:90}).toBuffer();
  return {data,mediaType:'image/jpeg',totalFrames,frameCount:count,durationMs,frames};
}

export function imageAttachments({root,loadFile,downloadFile,showError}){
  const entries=new Map();
  const viewer=document.createElement('dialog');viewer.className='image-viewer';viewer.setAttribute('aria-label','图片查看');
  const picture=document.createElement('img');
  const controls=document.createElement('div');controls.className='image-viewer-controls';
  const save=document.createElement('button');save.type='button';save.textContent='下载原图';
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>viewer.close();
  controls.append(save,close);viewer.append(picture,controls);document.body.append(viewer);
  viewer.addEventListener('click',event=>{if(event.target===viewer)viewer.close();});
  viewer.addEventListener('close',()=>picture.removeAttribute('src'));
  const observer=new IntersectionObserver(items=>{for(const item of items)if(item.isIntersecting){observer.unobserve(item.target);void item.target.loadImage();}},{root,rootMargin:'200px'});
  return {
    render(key,file){
      if(entries.has(key))return entries.get(key).button;
      const button=document.createElement('button');button.type='button';button.className='image-attachment'+(file.stickerId?' sticker-message':'');
      button.setAttribute('aria-label','查看图片：'+file.name);
      const image=document.createElement('img');image.alt=file.caption||file.name;image.decoding='async';image.hidden=true;
      const status=document.createElement('span');status.textContent='图片加载中…';button.append(image,status);
      const entry={button,url:null,loading:false};entries.set(key,entry);
      button.loadImage=async()=>{
        if(entry.url||entry.loading)return;
        entry.loading=true;status.textContent='图片加载中…';button.setAttribute('aria-busy','true');
        const bottom=root.scrollHeight-root.scrollTop-root.clientHeight<80;
        try{
          const blob=await loadFile(file);
          if(entries.get(key)!==entry)return;
          entry.url=URL.createObjectURL(new Blob([blob],{type:file.mediaType}));image.src=entry.url;
          await image.decode();
          image.hidden=false;status.hidden=true;
          if(bottom)root.scrollTop=root.scrollHeight;
        }catch{
          if(entry.url)URL.revokeObjectURL(entry.url);entry.url=null;image.removeAttribute('src');
          status.textContent='图片加载失败 · 点击重试';
        }finally{entry.loading=false;button.removeAttribute('aria-busy');}
      };
      button.onclick=()=>{
        if(!entry.url){void button.loadImage();return;}
        picture.src=entry.url;picture.alt=file.name;
        save.onclick=async()=>{save.disabled=true;try{await downloadFile(file);}catch(error){showError(error);}finally{save.disabled=false;}};
        viewer.showModal();
      };
      observer.observe(button);return button;
    },
    prune(keys){for(const [key,entry]of entries)if(!keys.has(key)){observer.unobserve(entry.button);if(entry.url)URL.revokeObjectURL(entry.url);entries.delete(key);}},
    close(){observer.disconnect();viewer.close();viewer.remove();this.prune(new Set());}
  };
}

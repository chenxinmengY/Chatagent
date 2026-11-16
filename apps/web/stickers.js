export function stickerPicker({root,button,api,load,send,importFiles,showError}){
  let generation=0,offset=0,hasMore=false,busy=false,timer;
  const urls=new Set();
  const header=document.createElement('div');header.className='sticker-header';
  const title=document.createElement('strong');title.textContent='我的表情';
  const add=document.createElement('button');add.type='button';add.textContent='导入表情包';
  const close=document.createElement('button');close.type='button';close.textContent='收起';
  const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/gif,image/webp';input.multiple=true;input.hidden=true;input.setAttribute('aria-label','导入表情图片');
  const search=document.createElement('input');search.type='search';search.placeholder='搜索表情';search.setAttribute('aria-label','搜索我的表情');
  const status=document.createElement('p');status.className='sticker-status';status.setAttribute('role','status');
  const grid=document.createElement('div');grid.className='sticker-grid';
  const more=document.createElement('button');more.type='button';more.textContent='加载更多';more.hidden=true;
  header.append(title,add,close);root.append(header,search,status,grid,more,input);
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);void entry.target.loadPreview();}},{root,rootMargin:'100px'});
  function clear(){observer.disconnect();for(const url of urls)URL.revokeObjectURL(url);urls.clear();grid.replaceChildren();}
  async function refresh(reset=true){
    const current=reset?++generation:generation;if(reset){offset=0;clear();}more.disabled=true;status.textContent='正在读取表情…';
    try{
      const result=await api('/v1/stickers?'+new URLSearchParams({query:search.value??'',offset,limit:80}));if(current!==generation)return;
      for(const sticker of result.stickers){
        const item=document.createElement('button');item.type='button';item.className='sticker-item';item.setAttribute('aria-label','发送表情：'+(sticker.caption||sticker.name));item.title=sticker.caption||sticker.name;
        const image=document.createElement('img');image.alt=sticker.caption||'表情';image.decoding='async';item.append(image);
        item.loadPreview=async()=>{try{const blob=await load(sticker);if(current!==generation)return;const url=URL.createObjectURL(blob);urls.add(url);image.src=url;}catch{item.textContent='点击重试';}};
        item.onclick=async()=>{if(busy)return;if(!image.src){await item.loadPreview();return;}busy=true;item.disabled=true;try{await send(sticker);hide();}catch(error){showError(error);}finally{busy=false;item.disabled=false;}};
        grid.append(item);observer.observe(item);
      }
      offset=result.nextOffset;hasMore=result.hasMore;more.hidden=!hasMore;status.textContent=result.total?'共 '+result.total+' 张 · 点击发送':search.value?'没有找到匹配的表情':'还没有表情，点击“导入表情包”添加';
    }catch(error){if(current===generation){status.textContent='暂时无法读取表情，稍后重新打开试试';showError(error);}}finally{more.disabled=false;}
  }
  function hide(){root.hidden=true;button.setAttribute('aria-expanded','false');generation++;clearTimeout(timer);clear();}
  button.onclick=()=>{if(root.hidden){root.hidden=false;button.setAttribute('aria-expanded','true');void refresh();}else hide();};
  close.onclick=hide;search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>void refresh(),250);};more.onclick=()=>{if(hasMore)void refresh(false);};
  add.onclick=()=>input.click();input.onchange=async()=>{if(busy)return;busy=true;add.disabled=true;try{status.textContent='正在导入表情…';await importFiles([...input.files]);await refresh();}catch(error){showError(error);status.textContent='部分表情未能导入，已完成的会保留';await refresh();}finally{busy=false;add.disabled=false;input.value='';}};
  return {close:hide};
}

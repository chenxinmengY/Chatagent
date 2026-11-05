import {chatFetch,chatId,chatUrl} from './chat-scope.js';
export function installChatProfiles(){
 const timeline=document.getElementById('messages');if(!timeline)return;
 let profiles=null,version='',busy=false,chatName='';
 function decorate(){if(!profiles)return;for(const row of timeline.querySelectorAll('.message')){const id=row.classList.contains('user')?'self':'agent',p=profiles[id];let a=row.querySelector('.profile-avatar');if(!a){a=document.createElement('a');a.className='profile-avatar';a.href=chatUrl('/settings?section=profiles&person='+id);row.prepend(a);}a.setAttribute('aria-label','查看'+p.nickname+'的资料');const image=p.avatar||(id==='agent'?'/whale.svg':'');if(a.dataset.image!==image){a.replaceChildren();if(image){const img=document.createElement('img');img.src=image;img.alt=p.nickname;a.append(img);}else a.textContent='我';a.dataset.image=image;}}
 const title=document.querySelector('.chat-title');if(title){title.querySelector('h1').textContent=chatName||profiles.agent.nickname;document.title=(chatName||profiles.agent.nickname)+' · Chatagent';const img=title.querySelector('img');img.src=profiles.agent.avatar||'/whale.svg';img.style.borderRadius='5px';img.title='查看个人资料';img.onclick=()=>{location.href=chatUrl('/settings?section=profiles&person=agent');};}}
 const observer=new MutationObserver(decorate);observer.observe(timeline,{childList:true});
 async function refresh(){if(busy||document.hidden)return;busy=true;try{const boot=await(await chatFetch('/v1/bootstrap')).json(),r=await chatFetch('/v1/profiles?after='+encodeURIComponent(version),{headers:{'X-Chatagent-Token':boot.token}});if(!r.ok)return;const data=await r.json();if(data.profiles){profiles=data.profiles;version=data.version;}chatName=boot.chatName??'';decorate();}catch{}finally{busy=false;}}
 void refresh();const timer=setInterval(refresh,10000);addEventListener('focus',refresh);addEventListener('pagehide',()=>{clearInterval(timer);observer.disconnect();},{once:true});
}

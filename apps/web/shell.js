import {chatId,chatUrl,chatFetch} from './chat-scope.js';
import { applySavedAppearance } from './appearance.js';
applySavedAppearance();
import { installChatProfiles } from './profile-chat.js';
const links = [
  ['/overview', '概览', 'overview'], ['/chats', '聊天', 'chat'], ['/manage?tab=personas', '人格卡', 'profile'], ['/settings', '设置', 'settings'], ['/plugins', '插件', 'plugins']
];
const navIcons={overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-8.5A8.5 8.5 0 0 1 11.5 4h1a8.5 8.5 0 0 1 8.5 7.5Z"/><path d="M8 10h8M8 14h5"/>',profile:'<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="9" r="2.5"/><path d="M8 17c0-4 8-4 8 0"/>',settings:'<path d="M4 6h7m5 0h4M4 12h2m5 0h9M4 18h9m5 0h2"/><circle cx="13.5" cy="6" r="2.5"/><circle cx="8.5" cy="12" r="2.5"/><circle cx="15.5" cy="18" r="2.5"/>',plugins:'<path d="M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h5v-6a3 3 0 1 1 0-6V3h-6a3 3 0 1 1-6 0Z"/>'};
const params=new URLSearchParams(location.search);
const personaPage=location.pathname==='/manage'&&(params.get('tab')??'personas')==='personas'||location.pathname==='/settings'&&params.get('section')==='personas';
const side = document.querySelector('aside');
let selectedChat=chatId;
function scopeNavigation(){for(const a of document.querySelectorAll('aside nav a'))a.href=chatUrl(a.href,selectedChat);}
addEventListener('chatagent-selection',event=>{selectedChat=event.detail.id;scopeNavigation();});
function activeLink(href) {
  const target=new URL(href,location.origin);
  if(target.pathname==='/manage'&&target.searchParams.get('tab')==='personas')return personaPage;
  if(target.pathname==='/settings')return !personaPage&&['/settings','/customize','/models','/profiles','/devices','/manage'].includes(location.pathname);
  if(target.pathname==='/plugins')return ['/plugins','/archive'].includes(location.pathname);
  if(target.pathname==='/chats')return ['/chats','/'].includes(location.pathname);
  if(target.pathname!==location.pathname)return false;
  if(target.pathname==='/archive')return target.searchParams.get('kind')===((new URLSearchParams(location.search).get('kind')??'memories').replace(/^bili$/, 'bili-legacy'));
  if(target.pathname==='/manage')return target.searchParams.get('tab')===(new URLSearchParams(location.search).get('tab')??'personas');
  return target.hash===location.hash;
}
if (side) {
  const oldBottom = side.querySelector('.side-bottom');
  side.replaceChildren();
  const brand = document.createElement('a'); brand.href='/overview'; brand.className='brand';
  brand.innerHTML='<img src="/whale.svg" alt=""><span>fish with me<small>小鲸鱼的私人空间</small></span>'; side.append(brand);
  const label=document.createElement('small'); label.className='nav-label'; label.textContent='工作空间';side.append(label);
  const nav=document.createElement('nav');nav.setAttribute('aria-label','主导航');
  for(const [href,name,icon] of links){const a=document.createElement('a');a.href=chatUrl(href);a.className='nav-item';
    const selected=activeLink(href);
    if(selected){a.classList.add('selected');a.setAttribute('aria-current','page');}const glyph=document.createElement('span');glyph.className='nav-glyph';glyph.setAttribute('aria-hidden','true');glyph.innerHTML='<svg viewBox="0 0 24 24" focusable="false">'+navIcons[icon]+'</svg>';a.append(glyph,document.createTextNode(name));nav.append(a);}
  side.append(nav);
  addEventListener('hashchange',()=>{for(const a of nav.querySelectorAll('a')){const selected=activeLink(a.href);a.classList.toggle('selected',selected);if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}});
  addEventListener('chatagent-navigation',()=>{for(const a of nav.querySelectorAll('a')){const selected=activeLink(a.href);a.classList.toggle('selected',selected);if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}});
  if(oldBottom)side.append(oldBottom);else{const bottom=document.createElement('div');bottom.className='side-bottom';bottom.innerHTML='<span class="private-pill">● 私人连接</span><small>资料保存在自己的电脑<br>仅供已配对的设备访问</small>';side.append(bottom);}
}

installChatProfiles();

const settingsTabs=[['appearance','外观'],['profiles','个人资料'],['models','模型与连接'],['voice','语音'],['data','导入与备份'],['devices','设备'],['workspace','工作区']];
const settingsPage=!personaPage&&['/settings','/customize','/models','/profiles','/devices','/manage'].includes(location.pathname);
if(personaPage)document.querySelector('.management-tabs')?.remove();
if(settingsPage){
  let section=location.pathname==='/settings'?(params.get('section')??'appearance'):({'/customize':'appearance','/models':'models','/profiles':'profiles','/devices':'devices','/manage':params.get('tab')==='settings'?'reply':params.get('tab')??'personas'})[location.pathname];
  if(!settingsTabs.some(([id])=>id===section))section='appearance';
  document.body.dataset.hub='settings';document.title='设置 · fish with me';
  const nav=document.createElement('nav');nav.className='hub-tabs';nav.setAttribute('aria-label','设置分类');
  for(const [id,label] of settingsTabs){const a=document.createElement('a');a.href=chatUrl('/settings?section='+id);a.textContent=label;if(id==='voice'){a.hidden=true;a.dataset.voiceReplyTab='';}if(id===section){a.className='selected';a.setAttribute('aria-current','page');}nav.append(a);}
  fetch('/v1/bootstrap').then(r=>r.json()).then(boot=>{if(boot.voiceReplies===true)nav.querySelector('[data-voice-reply-tab]').hidden=false;}).catch(()=>{});
  document.querySelector('main header').after(nav);
  for(const card of document.querySelectorAll('[data-settings-section]'))card.hidden=card.dataset.settingsSection!==section;
}else if(['/plugins','/archive'].includes(location.pathname)){
  document.body.dataset.hub='plugins';const nav=document.createElement('nav');nav.className='hub-tabs';nav.setAttribute('aria-label','插件页面');
  for(const [href,label] of [['/plugins','插件与记忆配置'],['/plugins?section=records&kind=diaries','日记记录'],['/plugins?section=records&kind=bili-legacy','B站历史记录']]){const a=document.createElement('a');a.href=chatUrl(href);a.textContent=label;if(new URL(href,location.origin).search===(location.search??'')){a.className='selected';a.setAttribute('aria-current','page');}nav.append(a);}
  document.querySelector('main header').after(nav);
  fetch('/v1/bootstrap').then(r=>r.json()).then(boot=>{if(boot.backend==='dsh-bridge'){for(const a of nav.querySelectorAll('a'))if(new URL(a.href).search)a.remove();nav.remove();}}).catch(()=>{});
}

// Plugin pages come from the connected runtime; absent plugins never get empty menu entries.
fetch('/v1/bootstrap').then(r=>r.json()).then(boot=>{if(boot.backend==='not-connected'){const details=document.querySelector('.connection-details');if(details)details.open=true;}return chatFetch('/v1/plugins',{headers:{'X-Chatagent-Token':boot.token}});}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(plugins=>{
 if(!plugins.length)return;
 const css=document.createElement('link');css.rel='stylesheet';css.href='/plugin-detail.css';document.head.append(css);
 const nav=document.createElement('div');nav.className='plugin-subnav';nav.setAttribute('aria-label','我的插件');
 const host=document.getElementById('installed-plugins');
 for(const plugin of plugins){const url=chatUrl('/plugins?plugin='+encodeURIComponent(plugin.id)),link=document.createElement('a');link.href=url;link.textContent=plugin.name;if(params.get('plugin')===plugin.id){link.className='selected';link.setAttribute('aria-current','page');}nav.append(link);
 if(host){const card=document.createElement('section');card.className='installed-plugin';const title=document.createElement('h2'),description=document.createElement('p'),open=document.createElement('a');title.textContent=plugin.name;description.textContent=plugin.description;open.href=url;open.textContent='打开插件 →';card.append(title,description,open);host.append(card);}}
 side?.querySelector('nav')?.append(nav);scopeNavigation();
}).catch(()=>{});

const chatBack=document.getElementById('chat-list-link');if(chatBack)chatBack.href=chatUrl('/chats');

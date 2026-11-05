export const chatId=new URLSearchParams(location.search).get('chat')||'default';
if(chatId!=='default'&&!/^[a-f0-9-]{36}$/.test(chatId))throw Error('INVALID_CHAT');
export const chatUrl=(url,id=chatId)=>{const target=new URL(url,location.origin);if(id!=='default')target.searchParams.set('chat',id);else target.searchParams.delete('chat');return target.pathname+target.search+target.hash;};
export const chatRoute=(route,id=chatId)=>id==='default'?route:'/v1/chats/'+id+route;
export async function chatFetch(route,options={}){
 if(chatId==='default'||!route.startsWith('/v1/'))return fetch(route,options);
 if(route==='/v1/bootstrap'){const root=await(await fetch(route)).json();return fetch(chatRoute(route),{...options,headers:{...options.headers,'X-Chatagent-Token':root.token}});}
 return fetch(chatRoute(route),options);
}

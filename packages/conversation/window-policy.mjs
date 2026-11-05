export const DEFAULT_WINDOW_POLICY=Object.freeze({recentWindowTokens:12000,recentWindowMessages:80,topicSummaryEnabled:true});
export function windowPolicy(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CHAT_WINDOW_POLICY_INVALID');
 const result=Object.fromEntries(Object.entries(DEFAULT_WINDOW_POLICY).map(([key,fallback])=>[key,value[key]??fallback]));
 const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
 if(!integer(result.recentWindowTokens,2000,64000)||!integer(result.recentWindowMessages,4,300)||typeof result.topicSummaryEnabled!=='boolean'||Object.keys(DEFAULT_WINDOW_POLICY).some(k=>value[k]===null))throw Error('CHAT_WINDOW_POLICY_INVALID');
 return result;
}
// A local text estimate, not provider token usage or a billing measurement.
export function estimateWindowTokens(text){const nonAscii=(text.match(/[^\x00-\x7f]/gu)??[]).length;return Math.ceil((text.length-nonAscii)/4+nonAscii);}

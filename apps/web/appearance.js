import { DEFAULT_APPEARANCE, validateAppearance } from './appearance-values.js';
export {DEFAULT_APPEARANCE};
export function savedAppearance(){try{return validateAppearance(JSON.parse(localStorage.getItem('chatagent-appearance')));}catch{return {...DEFAULT_APPEARANCE};}}
export function applyAppearance(value,target=document.documentElement){validateAppearance(value);const tint='#'+[1,3,5].map(i=>Math.round(parseInt(value.accent.slice(i,i+2),16)*0.16+255*0.84).toString(16).padStart(2,'0')).join('');for(const [key,v] of Object.entries({'--blue':value.accent,'--blue-hover':value.accent,'--user-bubble':tint,'--chat-background':value.background,'--chat-font':value.fontSize+'px','--chat-radius':value.radius+'px'}))target.style.setProperty(key,v);}
export function applySavedAppearance(){applyAppearance(savedAppearance());let link=document.querySelector('link[data-appearance]');if(!link){link=document.createElement('link');link.rel='stylesheet';link.href='/customize.css';link.dataset.appearance='';document.head.append(link);}}
export function saveAppearance(value){validateAppearance(value);localStorage.setItem('chatagent-appearance',JSON.stringify(value));applyAppearance(value);}

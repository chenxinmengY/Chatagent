// Adapted from yyh-001/dsh-meme (MIT), memes.js: keywordTokens/biGrams/searchRows.
// Copyright (c) 2026 Selfloom contributors. See dsh-meme-LICENSE.
export function searchRows(rows,query,limit=8){
  const tokens=[...new Set(String(query??'').trim().toLowerCase().split(/[\s,，、;；/|]+/).filter(Boolean))];
  if(!tokens.length)return rows.slice(0,limit);
  const scan=words=>rows.map(row=>({row,score:words.reduce((n,w)=>n+(String(row.tag+' '+row.caption+' '+row.keywords+' '+row.name).toLowerCase().includes(w)?1:0),0)})).filter(h=>h.score>0);
  let hits=scan(tokens);
  if(!hits.length){const grams=[...new Set(tokens.filter(t=>t.length>=3&&/[\u4e00-\u9fff]/.test(t)).flatMap(t=>Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2))))];if(grams.length)hits=scan(grams);}
  return hits.sort((a,b)=>b.score-a.score).slice(0,limit).map(h=>h.row);
}

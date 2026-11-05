export class BubbleArrival {
  seen=new Set(); waiting=new Map(); next=0; primed=false;
  prime(ids){if(!this.primed){for(const id of ids)this.seen.add(id);this.primed=true;}}
  reset(){this.seen.clear();this.waiting.clear();this.next=0;this.primed=false;}
  ready(now){return [...this.waiting.values()].some(at=>at<=now);}
  state(id,incoming,createdAt,now){
    if(!this.seen.has(id)){this.seen.add(id);if(incoming&&createdAt>=now-30000&&createdAt<=now+5000){const at=Math.max(now,this.next);this.waiting.set(id,at);this.next=at+850;}}
    const at=this.waiting.get(id);if(at===undefined)return 0;if(at>now)return -1;this.waiting.delete(id);return 1;
  }
}

package local.chatagent.privatechat;

import java.util.*;

// Presentation only: messages remain saved even while waiting for their turn on screen.
final class BubbleArrival {
  private final Set<String> seen=new HashSet<>();
  private final Map<String,Long> waiting=new HashMap<>();
  private long next;
  private boolean primed;
  void prime(Collection<String> ids){if(!primed){seen.addAll(ids);primed=true;}}
  void reset(){seen.clear();waiting.clear();next=0;primed=false;}
  boolean ready(long now){for(long at:waiting.values())if(at<=now)return true;return false;}
  // -1 waits, 0 displays normally, 1 displays with a short entrance animation.
  int state(String id,boolean incoming,long createdAt,long now){
    if(seen.add(id)&&incoming&&createdAt>=now-30000&&createdAt<=now+5000){long at=Math.max(now,next);waiting.put(id,at);next=at+850;}
    Long at=waiting.get(id);if(at==null)return 0;if(at>now)return -1;waiting.remove(id);return 1;
  }
}

package local.chatagent.privatechat;

import android.view.View;
import android.widget.LinearLayout;
import java.util.*;

// Keep unchanged bubbles attached; only new or changed messages need Android views.
final class TimelineViews {
  private static final class Entry {
    final String signature;final View view;
    Entry(String signature,View view){this.signature=signature;this.view=view;}
  }
  private final LinearLayout host;
  private Map<String,Entry> cached=new HashMap<>(),next;
  private int position;
  private String context="";
  TimelineViews(LinearLayout host){this.host=host;}
  void begin(String value){if(!value.equals(context)){cached.clear();context=value;}position=0;next=new HashMap<>();}
  boolean reuse(String key,String signature){Entry entry=cached.get(key);if(entry==null||!entry.signature.equals(signature))return false;place(key,entry);return true;}
  void put(String key,String signature,View view){Entry old=cached.get(key);if(old!=null)host.removeView(old.view);place(key,new Entry(signature,view));}
  private void place(String key,Entry entry){if(host.getChildAt(position)!=entry.view){if(entry.view.getParent()==host)host.removeView(entry.view);host.addView(entry.view,position);}position++;next.put(key,entry);}
  void end(){while(host.getChildCount()>position)host.removeViewAt(position);cached=next;next=null;}
}

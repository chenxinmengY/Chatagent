package local.chatagent.privatechat;
import android.content.Context;
import android.widget.ScrollView;

// A voice scrub must not scroll the chat when Android lays out or changes focus.
final class PinnedScrollView extends ScrollView {
  private boolean pinned;
  private int pinnedY;
  private boolean resized, resizeBottom;
  private int resizeY;
  PinnedScrollView(Context context){super(context);}
  void pinPosition(){if(!pinned){pinnedY=getScrollY();pinned=true;}}
  boolean positionPinned(){return pinned;}
  void releasePosition(){if(!pinned)return;final int y=pinnedY;super.scrollTo(0,y);pinned=false;}
  @Override public void scrollTo(int x,int y){super.scrollTo(x,pinned?pinnedY:y);}
  private int bottom(int height){return getChildCount()==0?0:Math.max(0,getChildAt(0).getBottom()+getPaddingBottom()-height);}
  @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){
    if(h!=oldh&&oldh>0){resizeY=getScrollY();resizeBottom=bottom(oldh)-resizeY<=64*getResources().getDisplayMetrics().density;resized=true;}
    // Android may animate a focused child's scroll after layout, overriding our anchor.
    boolean smooth=isSmoothScrollingEnabled();
    setSmoothScrollingEnabled(false);
    try{super.onSizeChanged(w,h,oldw,oldh);}finally{setSmoothScrollingEnabled(smooth);}
  }
  @Override protected void onLayout(boolean changed,int l,int t,int r,int b){
    super.onLayout(changed,l,t,r,b);
    if(pinned)super.scrollTo(0,pinnedY);
    else if(resized)super.scrollTo(0,resizeBottom?bottom(b-t):resizeY);
    resized=false;
  }
}

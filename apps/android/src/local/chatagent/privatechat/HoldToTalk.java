package local.chatagent.privatechat;

// Gesture state is independent from recording/permissions. Only one completed
// press can send; cancellation, extra pointers and lifecycle interruption cannot.
public final class HoldToTalk {
  private boolean active,cancel;
  private float startY;
  public boolean begin(float y){if(active)return false;active=true;cancel=false;startY=y;return true;}
  public void move(float y,float threshold){if(active)cancel=startY-y>=threshold;}
  public boolean cancelling(){return active&&cancel;}
  public boolean finish(){boolean send=active&&!cancel;active=false;cancel=false;return send;}
  public void cancel(){active=false;cancel=false;}
}

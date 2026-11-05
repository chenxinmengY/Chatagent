package local.chatagent.privatechat;

public final class VoiceSeekGesture {
  private float startX;
  private int origin,total,target;
  private boolean armed,dragging;
  public void begin(float x,int position,int duration){startX=x;origin=Math.max(0,position);total=Math.max(0,duration);target=Math.min(origin,total);armed=false;dragging=false;}
  public void arm(){armed=true;}
  public boolean armed(){return armed;}
  public boolean dragging(){return dragging;}
  public int target(){return target;}
  public int move(float x,float width,float threshold){if(armed&&total>0&&width>0&&(dragging||Math.abs(x-startX)>=threshold)){dragging=true;target=(int)Math.max(0,Math.min(total,origin+(x-startX)/width*total));}return target;}
  public void cancel(){armed=false;dragging=false;}
}

package local.chatagent.privatechat;

import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.view.*;
import android.widget.*;

final class VoiceBar extends LinearLayout {
  interface Actions {void play();void menu();void seek(int position);void preview(int position,int duration);void endPreview();}
  private final String id;
  private final boolean mine;
  private final TextView label;
  private final Wave icon;
  private final Handler clock=new Handler();
  private boolean attached;
  private final Actions actions;
  private final VoiceSeekGesture gesture=new VoiceSeekGesture();
  private float downX,downY;
  private boolean moved;
  private final Runnable hold=new Runnable(){public void run(){if(!attached||moved)return;gesture.arm();getParent().requestDisallowInterceptTouchEvent(true);performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);actions.preview(gesture.target(),AudioPlayer.duration(id));}};
  private final Runnable tick=new Runnable(){public void run(){if(!attached)return;refresh();clock.postDelayed(this,200);}};
  private int dp(int n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
  VoiceBar(Context context,String id,boolean mine,int duration,Actions actions){
    super(context);this.id=id;this.mine=mine;this.actions=actions;AudioPlayer.rememberDuration(id,duration);setGravity(Gravity.CENTER_VERTICAL);setPadding(dp(14),0,dp(14),0);setMinimumHeight(dp(44));setMinimumWidth(dp(148));setClickable(true);setFocusable(true);
    GradientDrawable background=new GradientDrawable();background.setColor(mine?0xff95ec69:Color.WHITE);background.setCornerRadius(dp(7));setBackground(background);setElevation(0);setTranslationZ(0);setStateListAnimator(null);
    label=new TextView(context);label.setTextColor(0xff202820);label.setTextSize(15);label.setGravity(mine?Gravity.RIGHT:Gravity.LEFT);icon=new Wave(context);
    LayoutParams wave=new LayoutParams(dp(24),dp(30));LayoutParams words=new LayoutParams(0,-2,1);
    if(mine){addView(label,words);wave.leftMargin=dp(18);addView(icon,wave);}else{wave.rightMargin=dp(18);addView(icon,wave);addView(label,words);}
    setOnClickListener(v->actions.play());setOnLongClickListener(v->{actions.menu();return true;});refresh();
  }
  public boolean onTouchEvent(MotionEvent event){
    switch(event.getActionMasked()){
      case MotionEvent.ACTION_DOWN:downX=event.getRawX();downY=event.getRawY();moved=false;gesture.begin(downX,AudioPlayer.position(id),AudioPlayer.duration(id));clock.postDelayed(hold,ViewConfiguration.getLongPressTimeout());return true;
      case MotionEvent.ACTION_MOVE:
        if(!gesture.armed()&&(Math.abs(event.getRawX()-downX)>dp(10)||Math.abs(event.getRawY()-downY)>dp(10))){moved=true;clock.removeCallbacks(hold);}
        if(gesture.armed()){boolean wasDragging=gesture.dragging();int target=gesture.move(event.getRawX(),getWidth()-dp(28),dp(8));if(gesture.dragging()){if(!wasDragging)AudioPlayer.beginScrub(id);actions.preview(target,AudioPlayer.duration(id));invalidate();}}return true;
      case MotionEvent.ACTION_UP:clock.removeCallbacks(hold);getParent().requestDisallowInterceptTouchEvent(false);if(gesture.dragging())actions.seek(gesture.target());else if(gesture.armed())actions.menu();else if(!moved)performClick();gesture.cancel();actions.endPreview();return true;
      case MotionEvent.ACTION_CANCEL:case MotionEvent.ACTION_POINTER_DOWN:clock.removeCallbacks(hold);getParent().requestDisallowInterceptTouchEvent(false);AudioPlayer.cancelScrub(id);gesture.cancel();moved=true;actions.endPreview();return true;
      default:return true;
    }
  }
  private void refresh(){String state=AudioPlayer.state(id);int seconds=AudioPlayer.seconds(id);String text=seconds>0?seconds+"″":"读取时长…";
    if(state.equals("loading"))text=seconds>0?seconds+"″ · 加载中":"加载中…";if(state.equals("error"))text="点按重试";label.setText(text);setContentDescription((mine?"我发送的":"小鲸鱼的")+"语音，点击播放或停止，再次播放从头开始，长按转文字或拖动进度"+(seconds>0?"，"+seconds+"秒":""));icon.invalidate();invalidate();}
  protected void onAttachedToWindow(){super.onAttachedToWindow();attached=true;clock.post(tick);}
  protected void onDetachedFromWindow(){attached=false;clock.removeCallbacks(tick);clock.removeCallbacks(hold);if(gesture.armed()){AudioPlayer.cancelScrub(id);gesture.cancel();actions.endPreview();}super.onDetachedFromWindow();}
  protected void dispatchDraw(Canvas canvas){super.dispatchDraw(canvas);int duration=AudioPlayer.duration(id);if(duration>0&&(gesture.dragging()||AudioPlayer.state(id).matches("playing|paused|seeking"))){Paint p=new Paint(3);p.setColor(mine?0xff4d9a35:0xff5b9c65);float width=(getWidth()-dp(28))*Math.min(1f,(float)(gesture.dragging()?gesture.target():AudioPlayer.position(id))/duration);canvas.drawRoundRect(dp(14),getHeight()-dp(3),dp(14)+width,getHeight()-dp(1),dp(1),dp(1),p);}}
  private final class Wave extends View {
    private final Paint paint=new Paint(3);
    Wave(Context context){super(context);}
    protected void onDraw(Canvas canvas){super.onDraw(canvas);canvas.save();canvas.scale(getWidth()/24f,getHeight()/30f);if(mine){canvas.translate(24,0);canvas.scale(-1,1);}paint.setColor(0xff263c28);paint.setStrokeWidth(2);paint.setStrokeCap(Paint.Cap.ROUND);paint.setStyle(Paint.Style.STROKE);int arcs=AudioPlayer.state(id).equals("playing")?(int)(System.currentTimeMillis()/260%3)+1:3;canvas.drawLine(5,14,5,16,paint);if(arcs>=2)canvas.drawArc(-3,8,15,22,-48,96,false,paint);if(arcs>=3)canvas.drawArc(-7,3,23,27,-48,96,false,paint);canvas.restore();}
  }
}

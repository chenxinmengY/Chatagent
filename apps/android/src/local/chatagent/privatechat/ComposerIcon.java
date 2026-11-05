package local.chatagent.privatechat;
import android.content.Context;
import android.graphics.*;
import android.view.View;

final class ComposerIcon extends View {
  private String kind;
  private final Paint paint=new Paint(3);
  ComposerIcon(Context context,String kind){super(context);this.kind=kind;setClickable(true);setFocusable(true);}
  void kind(String value){kind=value;invalidate();}
  protected void onDraw(Canvas canvas){super.onDraw(canvas);canvas.save();float size=Math.min(getWidth(),getHeight());canvas.translate((getWidth()-size)/2,(getHeight()-size)/2);canvas.scale(size/44,size/44);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(1.65f);paint.setColor(0xff303030);
    if(kind.equals("keyboard")){canvas.drawRoundRect(8,12,36,32,3,3,paint);paint.setStrokeWidth(2);for(int y=17;y<=22;y+=5)for(int x=13;x<=31;x+=6)canvas.drawPoint(x,y,paint);canvas.drawLine(14,27,30,27,paint);}
    else {canvas.drawCircle(22,22,13,paint);if(kind.equals("plus")){canvas.drawLine(15,22,29,22,paint);canvas.drawLine(22,15,22,29,paint);}else{canvas.drawLine(16,19,16,25,paint);canvas.drawArc(14,15,24,29,-65,130,false,paint);canvas.drawArc(12,11,30,33,-55,110,false,paint);}}
    canvas.restore();}
}

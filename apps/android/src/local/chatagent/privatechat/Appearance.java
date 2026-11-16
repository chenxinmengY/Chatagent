package local.chatagent.privatechat;
import android.app.*;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.widget.*;

final class Appearance {
  static int bubble(int c){return Color.rgb(Math.round(Color.red(c)*.16f+255*.84f),Math.round(Color.green(c)*.16f+255*.84f),Math.round(Color.blue(c)*.16f+255*.84f));}
  static int accent(LocalStore s){return Integer.parseInt(s.readMeta("lookAccent",String.valueOf(0xff3478e5)));}
  static int background(LocalStore s){return Integer.parseInt(s.readMeta("lookBackground",String.valueOf(0xfff5f7fb)));}
  static int font(LocalStore s){return Integer.parseInt(s.readMeta("lookFont","15"));}
  static int radius(LocalStore s){return Integer.parseInt(s.readMeta("lookRadius","12"));}
  static int action(int c){return Color.rgb(Math.round(Color.red(c)*.85f),Math.round(Color.green(c)*.85f),Math.round(Color.blue(c)*.85f));}
  static int onAccent(int c){double[] v={Color.red(c)/255.0,Color.green(c)/255.0,Color.blue(c)/255.0};for(int i=0;i<3;i++)v[i]=v[i]<=.04045?v[i]/12.92:Math.pow((v[i]+.055)/1.055,2.4);return v[0]*.2126+v[1]*.7152+v[2]*.0722>.179?Color.BLACK:Color.WHITE;}
  private static int dp(Activity a,int n){return (int)(n*a.getResources().getDisplayMetrics().density+.5f);}
  private static TextView text(Activity a,String value,int size){TextView t=new TextView(a);t.setText(value);t.setTextSize(size);t.setTextColor(0xff26364d);return t;}
  private static GradientDrawable shape(Activity a,int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(a,radius));return d;}
  private static void row(Activity a,LocalStore s,LinearLayout parent,TextView content,boolean mine){
    LinearLayout line=new LinearLayout(a);line.setGravity(mine?Gravity.RIGHT:Gravity.LEFT);android.view.View avatar=ProfileData.avatar(a,ProfileData.read(s,mine?"self":"agent"),mine);content.setMaxWidth((int)(a.getResources().getDisplayMetrics().widthPixels*.53f));content.setPadding(dp(a,12),dp(a,10),dp(a,12),dp(a,10));LinearLayout.LayoutParams face=new LinearLayout.LayoutParams(dp(a,28),dp(a,28)),bubble=new LinearLayout.LayoutParams(-2,-2);if(mine){bubble.rightMargin=dp(a,8);line.addView(content,bubble);line.addView(avatar,face);}else{bubble.leftMargin=dp(a,8);line.addView(avatar,face);line.addView(content,bubble);}LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(a,12);parent.addView(line,p);
  }
  static void open(Activity a,LocalStore s,Runnable saved){
    ScrollView scroll=new ScrollView(a);LinearLayout box=new LinearLayout(a);box.setOrientation(1);box.setPadding(dp(a,20),dp(a,12),dp(a,20),dp(a,16));scroll.addView(box);
    TextView intro=text(a,"仅保存在当前手机，保存前可预览。",13);intro.setPadding(0,0,0,dp(a,16));box.addView(intro);
    int[] colors={0xff3478e5,0xff8b5cf6,0xff167d6b,0xffb54760};String[] names={"蓝色","紫色","绿色","玫瑰色"};
    int[] backgrounds={0xfff5f7fb,0xfff4efff,0xffeff7ef,0xfffff3e8};
    Spinner color=new Spinner(a),background=new Spinner(a);color.setAdapter(new ArrayAdapter<String>(a,android.R.layout.simple_spinner_dropdown_item,names));background.setAdapter(new ArrayAdapter<String>(a,android.R.layout.simple_spinner_dropdown_item,new String[]{"浅灰背景","淡紫背景","淡绿背景","暖色背景"}));
    int selected=-1,back=-1;for(int i=0;i<colors.length;i++){if(colors[i]==accent(s))selected=i;if(backgrounds[i]==background(s))back=i;}color.setSelection(Math.max(0,selected));background.setSelection(Math.max(0,back));box.addView(text(a,"主题色",13));color.setMinimumHeight(dp(a,48));box.addView(color);box.addView(text(a,"聊天背景",13));background.setMinimumHeight(dp(a,48));box.addView(background);
    TextView sizeLabel=new TextView(a);box.addView(sizeLabel);SeekBar size=new SeekBar(a);size.setMax(12);size.setProgress(font(s)-12);box.addView(size);
    TextView roundLabel=new TextView(a);box.addView(roundLabel);SeekBar round=new SeekBar(a);round.setMax(28);round.setProgress(radius(s));box.addView(round);
    LinearLayout preview=new LinearLayout(a);preview.setOrientation(1);preview.setPadding(dp(a,12),dp(a,16),dp(a,12),dp(a,12));TextView heading=text(a,"聊天效果预览",13);heading.setPadding(0,0,0,dp(a,16));preview.addView(heading);
    TextView received=text(a,"今天也想听你说说发生了什么。",font(s)),sent=text(a,"好呀，我们慢慢聊。",font(s)),voice=text(a,"▂ ▅ ▇       12″",font(s)),file=text(a,"周末的小计划.txt\n2 KB · 文件",14);row(a,s,preview,received,false);row(a,s,preview,sent,true);row(a,s,preview,voice,true);row(a,s,preview,file,false);
    LinearLayout composer=new LinearLayout(a);composer.setGravity(Gravity.CENTER_VERTICAL);composer.setPadding(dp(a,10),dp(a,10),dp(a,10),dp(a,10));composer.setBackground(shape(a,Color.WHITE,12));TextView hint=text(a,"写给小鲸鱼…",14),send=text(a,"发送",13);send.setMinWidth(dp(a,56));send.setMinHeight(dp(a,34));send.setGravity(Gravity.CENTER);send.setPadding(dp(a,10),dp(a,6),dp(a,10),dp(a,6));composer.addView(hint,new LinearLayout.LayoutParams(0,-2,1));composer.addView(send);preview.addView(composer);box.addView(preview);
    Runnable update=()->{int font=12+size.getProgress(),radius=round.getProgress(),accent=colors[color.getSelectedItemPosition()];sizeLabel.setText("聊天字号："+font);roundLabel.setText("气泡圆角："+radius);for(TextView t:new TextView[]{received,sent,voice,file}){t.setTextSize(font);t.setBackground(shape(a,t==sent||t==voice?bubble(accent):Color.WHITE,radius));}send.setBackground(shape(a,action(accent),17));send.setTextColor(onAccent(action(accent)));preview.setBackground(shape(a,backgrounds[background.getSelectedItemPosition()],14));};
    SeekBar.OnSeekBarChangeListener seek=new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar b,int p,boolean u){update.run();}public void onStartTrackingTouch(SeekBar b){}public void onStopTrackingTouch(SeekBar b){}};size.setOnSeekBarChangeListener(seek);round.setOnSeekBarChangeListener(seek);
    android.widget.AdapterView.OnItemSelectedListener choice=new android.widget.AdapterView.OnItemSelectedListener(){public void onItemSelected(android.widget.AdapterView<?> v,android.view.View w,int p,long id){update.run();}public void onNothingSelected(android.widget.AdapterView<?> v){}};color.setOnItemSelectedListener(choice);background.setOnItemSelectedListener(choice);update.run();
    new AlertDialog.Builder(a).setTitle("外观与预览").setView(scroll).setNegativeButton("取消",null).setPositiveButton("保存",(d,n)->{s.meta("lookAccent",String.valueOf(colors[color.getSelectedItemPosition()]));s.meta("lookBackground",String.valueOf(backgrounds[background.getSelectedItemPosition()]));s.meta("lookFont",String.valueOf(12+size.getProgress()));s.meta("lookRadius",String.valueOf(round.getProgress()));saved.run();}).show();
  }
}

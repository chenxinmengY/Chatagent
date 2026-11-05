package local.chatagent.privatechat;
import android.app.*;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.widget.*;

final class Appearance {
  static int bubble(int c){return Color.rgb(Math.round(Color.red(c)*.16f+255*.84f),Math.round(Color.green(c)*.16f+255*.84f),Math.round(Color.blue(c)*.16f+255*.84f));}
  static int accent(LocalStore s){return Integer.parseInt(s.readMeta("lookAccent",String.valueOf(0xff3478e5)));}
  static int background(LocalStore s){return Integer.parseInt(s.readMeta("lookBackground",String.valueOf(0xfff5f7fb)));}
  static int font(LocalStore s){return Integer.parseInt(s.readMeta("lookFont","15"));}
  static int radius(LocalStore s){return Integer.parseInt(s.readMeta("lookRadius","12"));}
  static void open(Activity a,LocalStore s,Runnable saved){
    LinearLayout box=new LinearLayout(a);box.setOrientation(1);box.setPadding(30,20,30,20);
    TextView intro=new TextView(a);intro.setText("仅保存在当前手机，保存前可预览。");box.addView(intro);
    int[] colors={0xff3478e5,0xff8b5cf6,0xff167d6b,0xffb54760};String[] names={"蓝色","紫色","绿色","玫瑰色"};
    int[] backgrounds={0xfff5f7fb,0xfff4efff,0xffeff7ef,0xfffff3e8};
    Spinner color=new Spinner(a),background=new Spinner(a);color.setAdapter(new ArrayAdapter<String>(a,android.R.layout.simple_spinner_dropdown_item,names));background.setAdapter(new ArrayAdapter<String>(a,android.R.layout.simple_spinner_dropdown_item,new String[]{"浅灰背景","淡紫背景","淡绿背景","暖色背景"}));
    int selected=-1,back=-1;for(int i=0;i<colors.length;i++){if(colors[i]==accent(s))selected=i;if(backgrounds[i]==background(s))back=i;}color.setSelection(Math.max(0,selected));background.setSelection(Math.max(0,back));box.addView(color);box.addView(background);
    TextView sizeLabel=new TextView(a);box.addView(sizeLabel);SeekBar size=new SeekBar(a);size.setMax(12);size.setProgress(font(s)-12);box.addView(size);
    TextView roundLabel=new TextView(a);box.addView(roundLabel);SeekBar round=new SeekBar(a);round.setMax(28);round.setProgress(radius(s));box.addView(round);
    LinearLayout preview=new LinearLayout(a);preview.setPadding(25,25,25,25);TextView bubble=new TextView(a);bubble.setText("今天也想听你说说发生了什么。");bubble.setTextColor(0xff26364d);bubble.setPadding(20,15,20,15);preview.addView(bubble);box.addView(preview);
    Runnable update=()->{sizeLabel.setText("聊天字号："+(12+size.getProgress()));roundLabel.setText("气泡圆角："+round.getProgress());bubble.setTextSize(12+size.getProgress());GradientDrawable shape=new GradientDrawable();shape.setColor(bubble(colors[color.getSelectedItemPosition()]));shape.setCornerRadius(round.getProgress()*a.getResources().getDisplayMetrics().density);bubble.setBackground(shape);preview.setBackgroundColor(backgrounds[background.getSelectedItemPosition()]);};
    SeekBar.OnSeekBarChangeListener seek=new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar b,int p,boolean u){update.run();}public void onStartTrackingTouch(SeekBar b){}public void onStopTrackingTouch(SeekBar b){}};size.setOnSeekBarChangeListener(seek);round.setOnSeekBarChangeListener(seek);
    android.widget.AdapterView.OnItemSelectedListener choice=new android.widget.AdapterView.OnItemSelectedListener(){public void onItemSelected(android.widget.AdapterView<?> v,android.view.View w,int p,long id){update.run();}public void onNothingSelected(android.widget.AdapterView<?> v){}};color.setOnItemSelectedListener(choice);background.setOnItemSelectedListener(choice);update.run();
    new AlertDialog.Builder(a).setTitle("外观与预览").setView(box).setNegativeButton("取消",null).setPositiveButton("保存",(d,n)->{s.meta("lookAccent",String.valueOf(colors[color.getSelectedItemPosition()]));s.meta("lookBackground",String.valueOf(backgrounds[background.getSelectedItemPosition()]));s.meta("lookFont",String.valueOf(12+size.getProgress()));s.meta("lookRadius",String.valueOf(round.getProgress()));saved.run();}).show();
  }
}

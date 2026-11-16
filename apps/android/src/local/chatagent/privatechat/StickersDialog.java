package local.chatagent.privatechat;
import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.drawable.*;
import android.os.*;
import android.view.*;
import android.widget.*;
import android.text.*;
import java.io.*;
import java.net.URLEncoder;
import java.util.*;
import org.json.*;

final class StickersDialog {
  interface Sender{void send(JSONObject sticker)throws Exception;}
  private final Activity activity;private final JSONObject config;private final Sender sender;private final Runnable importer;
  private final Handler handler=new Handler();private final List<JSONObject> rows=new ArrayList<>();private final Set<Animatable> animations=new HashSet<>();
  private static final java.util.concurrent.ExecutorService PREVIEWS=java.util.concurrent.Executors.newFixedThreadPool(3);
  private Dialog dialog;private GridView grid;private TextView status;private EditText search;private Button more;private volatile int generation;private int offset;private boolean loading,sending,hasMore;private Runnable pending;
  StickersDialog(Activity activity,JSONObject config,Sender sender,Runnable importer){this.activity=activity;this.config=config;this.sender=sender;this.importer=importer;}
  private int dp(int v){return Math.round(v*activity.getResources().getDisplayMetrics().density);}
  private Button button(String label,Runnable action){Button b=new Button(activity);b.setText(label);b.setAllCaps(false);b.setOnClickListener(v->action.run());return b;}
  void show(){
    dialog=new Dialog(activity);LinearLayout body=new LinearLayout(activity);body.setOrientation(1);body.setPadding(dp(12),dp(10),dp(12),dp(10));body.setBackgroundColor(0xfff6f7fa);
    LinearLayout header=new LinearLayout(activity);header.setGravity(Gravity.CENTER_VERTICAL);TextView title=new TextView(activity);title.setText("我的表情");title.setTextSize(16);header.addView(title,new LinearLayout.LayoutParams(0,-2,1));header.addView(button("导入表情包",()->{dismiss();importer.run();}));header.addView(button("收起",this::dismiss));body.addView(header);
    search=new EditText(activity);search.setSingleLine(true);search.setTextSize(14);search.setHint("搜索表情");search.setContentDescription("搜索我的表情");body.addView(search,new LinearLayout.LayoutParams(-1,dp(44)));
    status=new TextView(activity);status.setTextSize(12);status.setTextColor(0xff61728a);body.addView(status);
    grid=new GridView(activity);grid.setNumColumns(4);grid.setVerticalSpacing(dp(8));grid.setHorizontalSpacing(dp(8));grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);grid.setAdapter(adapter);body.addView(grid,new LinearLayout.LayoutParams(-1,0,1));
    grid.setOnItemClickListener((parent,view,position,id)->{if(sending)return;sending=true;status.setText("正在发送…");JSONObject sticker=rows.get(position);SyncService.WORK.execute(()->{try{sender.send(sticker);activity.runOnUiThread(this::dismiss);}catch(Exception error){activity.runOnUiThread(()->{sending=false;status.setText("未能发送，原表情仍在，可稍后重试");});}});});
    more=button("加载更多",()->load(false));more.setVisibility(View.GONE);body.addView(more);dialog.setContentView(body);dialog.setOnDismissListener(d->{generation++;if(pending!=null)handler.removeCallbacks(pending);for(Animatable a:animations)a.stop();animations.clear();});dialog.show();Window window=dialog.getWindow();window.setGravity(Gravity.BOTTOM);window.setLayout(-1,Math.min(dp(430),(int)(activity.getResources().getDisplayMetrics().heightPixels*.65f)));window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){if(pending!=null)handler.removeCallbacks(pending);pending=()->load(true);handler.postDelayed(pending,250);}public void afterTextChanged(Editable e){}});load(true);
  }
  void dismiss(){if(dialog!=null)dialog.dismiss();}
  private void load(boolean reset){
    if(loading&&!reset)return;int current=reset?++generation:generation;String query=search.getText().toString();if(reset){offset=0;rows.clear();adapter.notifyDataSetChanged();}int start=offset;loading=true;more.setEnabled(false);status.setText("正在读取表情…");
    PREVIEWS.execute(()->{try{JSONObject result=new Api(config).object("/v1/stickers?offset="+start+"&limit=80&query="+URLEncoder.encode(query,"UTF-8"),null);activity.runOnUiThread(()->{if(current!=generation||!dialog.isShowing())return;JSONArray values=result.optJSONArray("stickers");if(values!=null)for(int i=0;i<values.length();i++)rows.add(values.optJSONObject(i));offset=result.optInt("nextOffset");hasMore=result.optBoolean("hasMore");loading=false;more.setEnabled(true);more.setVisibility(hasMore?View.VISIBLE:View.GONE);status.setText(result.optInt("total")==0?"没有表情，可从相册导入":"共 "+result.optInt("total")+" 张 · 点击发送");adapter.notifyDataSetChanged();});}catch(Exception error){activity.runOnUiThread(()->{if(current!=generation)return;loading=false;more.setEnabled(true);status.setText("暂时无法读取表情，请稍后重新打开");});}});
  }
  private final BaseAdapter adapter=new BaseAdapter(){public int getCount(){return rows.size();}public Object getItem(int p){return rows.get(p);}public long getItemId(int p){return p;}
    public View getView(int position,View recycled,android.view.ViewGroup parent){ImageView image=recycled instanceof ImageView?(ImageView)recycled:new ImageView(activity);Drawable old=image.getDrawable();if(old instanceof Animatable)((Animatable)old).stop();image.setImageDrawable(null);image.setScaleType(ImageView.ScaleType.FIT_CENTER);image.setPadding(dp(4),dp(4),dp(4),dp(4));image.setLayoutParams(new AbsListView.LayoutParams(-1,dp(76)));JSONObject sticker=rows.get(position);String id=sticker.optString("id");image.setTag(id);image.setContentDescription("发送表情："+sticker.optString("caption",sticker.optString("name")));int current=generation;
      PREVIEWS.execute(()->{try{if(current!=generation)return;Drawable drawable=StickerImages.decode(cache(activity,config,sticker),dp(144),dp(144));activity.runOnUiThread(()->{if(current!=generation||!id.equals(image.getTag())||!dialog.isShowing())return;image.setImageDrawable(drawable);if(drawable instanceof Animatable){animations.add((Animatable)drawable);((Animatable)drawable).start();}});}catch(Exception ignored){}});return image;}
  };
  private static File cache(Activity activity,JSONObject config,JSONObject sticker)throws Exception{
    File folder=new File(activity.getCacheDir(),"stickers");folder.mkdirs();File target=new File(folder,sticker.getString("sha256"));if(Files.valid(target,sticker))return target;
    byte[] data=new Api(config).exchange("/v1/stickers/"+sticker.getString("id")+"/content","GET",null,null);File temp=File.createTempFile("sticker-",".tmp",folder);try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(data);out.getFD().sync();}if(!Files.valid(temp,sticker))throw new Exception("FILE_HASH_MISMATCH");if(!temp.renameTo(target)&&!Files.valid(target,sticker))throw new Exception("FILE_SAVE_FAILED");return target;}finally{temp.delete();}
  }
}

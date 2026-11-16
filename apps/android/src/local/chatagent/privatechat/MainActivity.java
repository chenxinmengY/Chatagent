package local.chatagent.privatechat;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.text.TextUtils;
import java.text.SimpleDateFormat;
import android.net.Uri;
import android.os.*;
import android.provider.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.security.SecureRandom;
import java.util.*;

public final class MainActivity extends Activity {
  private LinearLayout root, timeline, pending;
  private TimelineViews timelineViews;
  private PinnedScrollView chatScroll;private ScrollView pendingScroll,conversationScroll;
  private String screen="chat";
  private TextView status, fileStatus;
  private LinearLayout replyActivityBar;
  private TextView replyActivityLabel;


  private EditText draft;
  private LocalStore store;
  private JSONObject config;
  private JSONArray draftFiles = new JSONArray();
  private final Handler handler = new Handler();
  private String rendered = "";
  private final BubbleArrival arrivals=new BubbleArrival();
  private String arrivalEpoch="";
  private final List<JSONObject> historyRows=new ArrayList<>();
  private String historyCursor="",historyQuery="",historyDate="",historyType="";
  private boolean historyBusy=false,historyMore=true;
  private static final int INITIAL_MESSAGES=30;
  private int localMessageLimit=INITIAL_MESSAGES;
  private boolean localMore;
  private int historyGeneration=0;
  private boolean active;
  private int audioRequest;
  private boolean pairingBusy, fileImporting;
  private VoiceRecorder recorder;
  private boolean voiceMode;
  private Button holdButton,sendButton;
  private ComposerIcon inputToggle,attachmentButton;
  private StickersDialog stickersDialog;
  private final List<android.graphics.drawable.Animatable> stickerAnimations=new ArrayList<>();
  private final HoldToTalk holdGesture=new HoldToTalk();
  private TextView recordingStatus,playbackPosition;
  private final Map<String,JSONObject> transcriptionRequests=new HashMap<>();
  private final Set<String> transcriptionPolling=new HashSet<>();
  private final Runnable hidePlaybackPosition=()->{if(playbackPosition!=null)playbackPosition.setVisibility(View.GONE);};
  private long recordingStarted;
  private final Runnable recordingClock=new Runnable(){public void run(){if(recorder==null)return;long seconds=(SystemClock.elapsedRealtime()-recordingStarted)/1000;showRecording(seconds);if(seconds>=120||recorder.finished()){finishRecording(!holdGesture.cancelling());return;}handler.postDelayed(this,200);}};
  private int blue=0xff3478e5, ink=0xff26364d, muted=0xff5c6e83, canvas=0xfff5f7fb;
  private final Runnable refresh = new Runnable() { public void run() { if (!active) return; if(screen.equals("conversations")&&!conversationsVersion.equals(inboxSignature()))conversations(); try { render(); } catch (Exception ignored) { } handler.postDelayed(this, 300); } };
  public void onCreate(Bundle state) { super.onCreate(state);String requested=getIntent().getStringExtra("chatId");if(requested!=null&&(requested.equals("default")||requested.matches("[a-f0-9-]{36}")))getSharedPreferences("chat-selection",0).edit().putString("id",requested).commit(); store = LocalStore.get(this); try { config = Secrets.load(this); } catch (Exception error) { config = null; }
    blue=Appearance.accent(store);canvas=Appearance.background(store);
    if (config == null || !config.has("deviceId")) pairing(); else chat();
  }
  public void onResume() { super.onResume();for(android.graphics.drawable.Animatable a:stickerAnimations)a.start(); active = true;if(screen.equals("background"))backgroundSettings();if(config!=null&&config.has("deviceId")&&ConnectionRecovery.enabled(this))try{startForegroundService(new Intent(this,SyncService.class));}catch(RuntimeException error){store.meta("status","系统限制后台启动，请检查后台与电池设置");}arrivals.reset();rendered="";updateMessageVisibility();for(JSONObject file:new ArrayList<>(transcriptionRequests.values()))pollTranscription(file,false); handler.post(refresh); String notice=store.readMeta("recordingNotice","");if(!notice.isEmpty()){Toast.makeText(this,notice,Toast.LENGTH_LONG).show();store.meta("recordingNotice","");} }
  @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);String id=intent.getStringExtra("chatId");if(id!=null&&(id.equals("default")||id.matches("[a-f0-9-]{36}")))selectConversation(id);}
  public void onPause() {if(stickersDialog!=null)stickersDialog.dismiss();for(android.graphics.drawable.Animatable a:stickerAnimations)a.stop(); audioRequest++;AudioPlayer.close();active = false;MessageNotifications.close(this); handler.removeCallbacks(refresh); if(recorder!=null){finishRecording(false);store.meta("recordingNotice","录音因离开页面已取消，没有发送。已有草稿保留。");} if (draft != null) store.meta("draft", draft.getText().toString()); super.onPause(); }
  public void onDestroy(){MessageNotifications.close(this);handler.removeCallbacks(recordingClock);if(recorder!=null){recorder.close();recorder=null;}super.onDestroy();}
  @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);updateMessageVisibility();}
  private void updateMessageVisibility(){
    if(!active||!hasWindowFocus()||!screen.equals("chat")||store==null||config==null||!config.has("deviceId")){MessageNotifications.close(this);return;}
    MessageNotifications.open(this,this,store.chatId,store::containsMessage);
  }
  private int dp(int value){return (int)(value*getResources().getDisplayMetrics().density+.5f);}
  private GradientDrawable rounded(int color,int radius){GradientDrawable shape=new GradientDrawable();shape.setColor(color);shape.setCornerRadius(dp(radius));return shape;}
  private LinearLayout column(){LinearLayout view=new LinearLayout(this);view.setOrientation(1);return view;}
  private TextView text(String value,int size){TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(ink);view.setPadding(0,dp(4),0,dp(4));return view;}
  private TextView quiet(String value,int size){TextView view=text(value,size);view.setTextColor(muted);return view;}
  private Button button(String label,Runnable action){Button view=new Button(this);view.setText(label);view.setTextSize(13);view.setAllCaps(false);view.setTextColor(blue);view.setMinHeight(dp(48));view.setMinimumHeight(dp(48));view.setMinWidth(0);view.setMinimumWidth(0);view.setPadding(dp(12),dp(8),dp(12),dp(8));view.setStateListAnimator(null);view.setTranslationZ(0);view.setElevation(0);view.setBackground(new RippleDrawable(ColorStateList.valueOf(0xffdbe9ff),rounded(0xffedf3fd,9),null));view.setOnClickListener(v->action.run());return view;}
  private Button primary(String label,Runnable action){Button view=button(label,action);view.setTextColor(Appearance.onAccent(Appearance.action(blue)));view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x263478e5),rounded(Appearance.action(blue),10),null));return view;}
  private void reset(String next){if(stickersDialog!=null)stickersDialog.dismiss();for(android.graphics.drawable.Animatable a:stickerAnimations)a.stop();stickerAnimations.clear();MessageNotifications.close(this);audioRequest++;AudioPlayer.close();if(recorder!=null)finishRecording(false);if(draft!=null)store.meta("draft",draft.getText().toString());screen=next;arrivals.reset();draft=null;timeline=null;pending=null;rendered="";root=column();root.setBackgroundColor(canvas);getWindow().setStatusBarColor(Color.WHITE);getWindow().setNavigationBarColor(Color.WHITE);getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);setContentView(root);}
  private void base(String title){reset("pairing");root.setPadding(dp(24),dp(28),dp(24),dp(18));TextView heading=text(title,25);heading.setTypeface(null,Typeface.BOLD);root.addView(heading);}
  private View avatar(boolean mine){View view=ProfileData.avatar(this,ProfileData.read(store,mine?"self":"agent"),mine);view.setContentDescription(mine?"我的资料":"小鲸鱼资料");view.setOnClickListener(v->ProfileData.open(this,mine?"self":"agent"));return view;}
  private void toolbar(String title,String subtitle,Runnable back,Runnable more){
    LinearLayout bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(dp(8),dp(10),dp(8),dp(10));bar.setBackgroundColor(Color.WHITE);
    ComposerIcon arrow=new ComposerIcon(this,"back");arrow.setContentDescription("返回");arrow.setOnClickListener(v->back.run());bar.addView(arrow,new LinearLayout.LayoutParams(dp(48),dp(48)));
    LinearLayout titles=column();TextView heading=text(title,18);heading.setTag("screen-title");heading.setTypeface(null,Typeface.BOLD);heading.setMaxLines(1);heading.setEllipsize(TextUtils.TruncateAt.END);titles.addView(heading);status=quiet(subtitle,12);titles.addView(status);bar.addView(titles,new LinearLayout.LayoutParams(0,-2,1));
    ComposerIcon menu=new ComposerIcon(this,"more");menu.setContentDescription("更多设置");menu.setOnClickListener(v->more.run());bar.addView(menu,new LinearLayout.LayoutParams(dp(48),dp(48)));root.addView(bar);
  }
  private void pickFile(String type){Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT);pick.setType(type);pick.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(pick,4);}
  private void updateFiles(){if(fileStatus!=null){fileStatus.setText(draftFiles.length()==0?"":"已选 "+draftFiles.length()+" 个附件 · 点击管理");fileStatus.setVisibility(draftFiles.length()==0?View.GONE:View.VISIBLE);}updateComposer();}
  private void pickImages(){int remaining=8-draftFiles.length();if(remaining<=0){Toast.makeText(this,"最多添加 8 个附件",Toast.LENGTH_LONG).show();return;}if(!PhotoPicker.multiple(this,4,remaining))Toast.makeText(this,"无法打开相册，请检查系统相册是否可用",Toast.LENGTH_LONG).show();}
  private void attachmentsMenu(){if(fileImporting||recorder!=null)return;new AlertDialog.Builder(this).setTitle("添加附件").setItems(new String[]{"添加图片","添加文件","清除已选附件"},(d,n)->{if(n==0)pickImages();if(n==1)pickFile("*/*");if(n==2){draftFiles=new JSONArray();store.meta("draftFiles","[]");updateFiles();}}).show();}
  private void updateComposer(){
    if(holdButton==null||draft==null)return;
    draft.setVisibility(voiceMode?View.GONE:View.VISIBLE);holdButton.setVisibility(voiceMode?View.VISIBLE:View.GONE);
    inputToggle.kind(voiceMode?"keyboard":"voice");inputToggle.setContentDescription(voiceMode?"切换键盘输入":"切换语音输入");
    boolean hasDraft=(!voiceMode&&!draft.getText().toString().trim().isEmpty())||draftFiles.length()>0;
    sendButton.setVisibility(hasDraft?View.VISIBLE:View.GONE);attachmentButton.setVisibility(hasDraft?View.GONE:View.VISIBLE);
  }
  private void toggleInput(){
    if(recorder!=null)return;voiceMode=!voiceMode;store.meta("voiceMode",String.valueOf(voiceMode));updateComposer();
    android.view.inputmethod.InputMethodManager keyboard=(android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE);
    if(voiceMode){keyboard.hideSoftInputFromWindow(draft.getWindowToken(),0);draft.clearFocus();}else{draft.requestFocus();keyboard.showSoftInput(draft,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);}
  }
  private boolean recordVoice(){
    if(recorder!=null||fileImporting||!screen.equals("chat"))return false;
    if(checkSelfPermission("android.permission.RECORD_AUDIO")!=0){requestPermissions(new String[]{"android.permission.RECORD_AUDIO"},5);return false;}
    try{
      File folder=new File(getFilesDir(),"media");folder.mkdirs();File temp=File.createTempFile("recording-",".wav",folder);
      recorder=new VoiceRecorder();try{recorder.start(temp);}catch(Exception e){recorder.close();recorder=null;temp.delete();throw e;}
      recordingStarted=SystemClock.elapsedRealtime();getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);recordingStatus.setVisibility(View.VISIBLE);handler.post(recordingClock);return true;
    }catch(Exception e){failure(new Exception("MIC_UNAVAILABLE"));return false;}
  }
  private void showRecording(long seconds){boolean cancel=holdGesture.cancelling();recordingStatus.setText((cancel?"松开取消":"正在录音 · 上滑取消")+" · "+seconds+" 秒 / 120秒");recordingStatus.setTextColor(cancel?0xffd64343:0xff168444);holdButton.setText(cancel?"松开取消":"松开发送");holdButton.setBackground(rounded(cancel?0xffffe2e2:0xffdce8dc,7));}
  private void queueVoice(JSONObject metadata)throws Exception{
    if(store.readMeta("epoch","").isEmpty())throw new Exception("FIRST_SYNC_REQUIRED");
    JSONArray files=new JSONArray().put(metadata),ids=new JSONArray().put(metadata.getString("id"));
    JSONObject message=new JSONObject().put("clientMessageId",UUID.randomUUID().toString()).put("deviceId",config.getString("deviceId")).put("text","").put("queuedAt",System.currentTimeMillis()).put("expectedMode",store.readMeta("mode","social")).put("expectedModeRevision",Long.parseLong(store.readMeta("modeRevision","0"))).put("epoch",store.readMeta("epoch","")).put("localState","queued").put("files",files).put("attachmentIds",ids);
    store.pending(message);chatScroll.followLatest();rendered="";
  }
  private void finishRecording(boolean keep){
    VoiceRecorder owned=recorder;if(owned==null){holdGesture.cancel();return;}recorder=null;holdGesture.cancel();handler.removeCallbacks(recordingClock);getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    recordingStatus.setVisibility(View.GONE);holdButton.setText("按住说话");holdButton.setBackground(rounded(Color.WHITE,12));holdButton.setPressed(false);
    try{
      File temp=owned.stop(keep);if(temp==null)return;
      String digest=Files.hash(temp);File target=new File(temp.getParentFile(),digest);if(!target.exists()&&!temp.renameTo(target))throw new Exception("FILE_SAVE_FAILED");
      JSONObject metadata=new JSONObject().put("id",UUID.randomUUID().toString()).put("name","语音-"+new SimpleDateFormat("MMdd-HHmmss",Locale.CHINA).format(new Date())+".wav").put("bytes",target.length()).put("sha256",digest);
      if(!Files.valid(target,metadata))throw new Exception("FILE_HASH_MISMATCH");
      try{queueVoice(metadata);}catch(Exception e){draftFiles.put(metadata);store.meta("draftFiles",draftFiles.toString());updateFiles();throw e;}
      render();
    }catch(Exception e){failure(e);}finally{owned.close();}
  }
  @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==5){if(results.length>0&&results[0]==0){Toast.makeText(this,"麦克风已允许，请重新按住说话",Toast.LENGTH_LONG).show();}else new AlertDialog.Builder(this).setMessage("需要麦克风权限才能录音。可在系统应用权限中开启，文字与已有草稿仍可使用。").setPositiveButton("知道了",null).setNeutralButton("系统设置",(d,n)->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())))).show();}}
  private void history(){if(historyBusy)return;if(localMore&&historyQuery.isEmpty()&&historyDate.isEmpty()&&historyType.isEmpty()){int height=timeline==null?0:timeline.getHeight(),y=chatScroll==null?0:chatScroll.getScrollY();localMessageLimit=Math.min(200,localMessageLimit+INITIAL_MESSAGES);if(!screen.equals("chat")){chat();return;}rendered="";try{render();chatScroll.retainAfterPrepend(height,y);}catch(Exception e){failure(e);}return;}if(!historyMore)return;historyBusy=true;final int generation=historyGeneration;final String query=historyQuery,dateValue=historyDate,typeValue=historyType,cursorValue=historyCursor;work(()->{String params="?q="+java.net.URLEncoder.encode(query,"UTF-8")+"&date="+dateValue+"&type="+typeValue;if(!cursorValue.isEmpty())params+="&before="+cursorValue;JSONObject page=new Api(config).object("/v1/timeline"+params,null);runOnUiThread(()->{if(generation!=historyGeneration)return;JSONArray rows=page.optJSONArray("messages");for(int i=0;i<rows.length();i++)historyRows.add(rows.optJSONObject(i));historyCursor=page.optString("nextBefore","");historyMore=page.optBoolean("hasMore");rendered="";if(!screen.equals("chat"))chat();else try{render();}catch(Exception e){failure(e);}});},()->{if(generation==historyGeneration)historyBusy=false;});}
  private void findHistory(){LinearLayout form=column();EditText query=new EditText(this),date=new EditText(this);query.setHint("关键词");query.setText(historyQuery);date.setHint("日期 YYYY-MM-DD，可留空");date.setText(historyDate);Spinner type=new Spinner(this);type.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"全部类型","图片","语音","文件"}));form.addView(query);form.addView(date);form.addView(type);new AlertDialog.Builder(this).setTitle("查找聊天").setView(form).setNegativeButton("取消",null).setNeutralButton("返回当前聊天",(d,n)->{historyGeneration++;historyBusy=false;historyQuery="";historyDate="";historyType="";historyCursor="";historyMore=true;historyRows.clear();chat();}).setPositiveButton("查找",(d,n)->{historyGeneration++;historyBusy=false;historyQuery=query.getText().toString();historyDate=date.getText().toString();historyType=new String[]{"","image","audio","file"}[type.getSelectedItemPosition()];historyRows.clear();historyCursor="";historyMore=true;history();}).show();}
  private void cacheSettings(){if(fileImporting||recorder!=null)return;work(()->{long[] info=MediaCache.inspect(new File(getFilesDir(),"media"),store,false);runOnUiThread(()->new AlertDialog.Builder(this).setTitle("本机媒体缓存").setMessage(String.format(Locale.CHINA,"媒体占用 %.2f MiB，可重新下载 %.2f MiB。清理保留草稿、待发及状态未确定的文件，电脑原件保留。",info[0]/1048576.0,info[1]/1048576.0)).setNegativeButton("返回",null).setPositiveButton("清理可下载缓存",(d,n)->{AudioPlayer.close();work(()->{long[] result=MediaCache.inspect(new File(getFilesDir(),"media"),store,true);runOnUiThread(()->Toast.makeText(this,String.format(Locale.CHINA,"已清理 %.2f MiB",result[2]/1048576.0),Toast.LENGTH_LONG).show());});}).show());});}
  private void settingRow(LinearLayout parent,String title,String subtitle,Runnable action){LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(18),dp(14),dp(16),dp(14));row.setBackgroundColor(Color.WHITE);LinearLayout words=column();words.addView(text(title,15));if(!subtitle.isEmpty())words.addView(quiet(subtitle,12));row.addView(words,new LinearLayout.LayoutParams(0,-2,1));row.addView(quiet("›",22));row.setOnClickListener(v->action.run());LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.bottomMargin=dp(1);parent.addView(row,params);}
  private void bottomTabs(boolean mine){LinearLayout tabs=new LinearLayout(this);tabs.setPadding(dp(25),dp(8),dp(25),dp(9));tabs.setBackgroundColor(Color.WHITE);Button chats=button("消息",this::conversations),profile=button("我的",this::settings);chats.setBackground(rounded(mine?Color.WHITE:0xffedf3fd,10));profile.setBackground(rounded(mine?0xffedf3fd:Color.WHITE,10));tabs.addView(chats,new LinearLayout.LayoutParams(0,dp(48),1));tabs.addView(profile,new LinearLayout.LayoutParams(0,dp(48),1));root.addView(tabs);}
  private String conversationsVersion="";
  private String chatCatalog(){return LocalStore.get(this,"default").readMeta("chatList","[{\"id\":\"default\",\"name\":\"小鲸鱼\"}]");}
  private String inboxSignature(){String catalog=chatCatalog();StringBuilder value=new StringBuilder(catalog);try{JSONArray chats=new JSONArray(catalog);for(int i=0;i<chats.length();i++)value.append(LocalStore.get(this,chats.getJSONObject(i).getString("id")).inbox().toString());}catch(Exception ignored){}return value.toString();}
  private void selectConversation(String id){if(fileImporting||recorder!=null)return;if(draft!=null)store.meta("draft",draft.getText().toString());AudioPlayer.close();if(id.equals(store.chatId)){historyGeneration++;historyBusy=false;historyMore=true;historyRows.clear();historyCursor="";historyQuery="";historyDate="";historyType="";localMessageLimit=INITIAL_MESSAGES;chat();return;}if(!getSharedPreferences("chat-selection",0).edit().putString("id",id).commit()){failure(new Exception("LOCAL_SAVE_FAILED"));return;}getIntent().removeExtra("chatId");recreate();}
  private void conversations(){int previousY=screen.equals("conversations")&&conversationScroll!=null?conversationScroll.getScrollY():0;reset("conversations");toolbar("消息","各个角色的独立聊天",this::chat,this::settings);ScrollView scroll=new ScrollView(this);conversationScroll=scroll;LinearLayout content=column();content.setPadding(dp(16),dp(18),dp(16),dp(18));
    conversationsVersion=inboxSignature();
    try{JSONArray chats=new JSONArray(chatCatalog());List<JSONObject> ordered=new ArrayList<>();Map<String,JSONObject> inboxes=new HashMap<>();for(int i=0;i<chats.length();i++){JSONObject item=chats.getJSONObject(i);ordered.add(item);inboxes.put(item.getString("id"),LocalStore.get(this,item.getString("id")).inbox());}ordered.sort((a,b)->Long.compare(inboxes.get(b.optString("id")).optLong("at"),inboxes.get(a.optString("id")).optLong("at")));
    for(JSONObject item:ordered){final String id=item.getString("id");LocalStore chatStore=LocalStore.get(this,id);JSONObject inbox=inboxes.get(id);LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(16),dp(18),dp(16),dp(18));row.setBackground(rounded(Color.WHITE,15));row.addView(ProfileData.avatar(this,ProfileData.read(chatStore,"agent"),false),new LinearLayout.LayoutParams(dp(49),dp(49)));LinearLayout words=column();words.setPadding(dp(14),0,dp(8),0);TextView title=text(item.getString("name"),17);title.setTypeface(null,Typeface.BOLD);title.setMaxLines(1);title.setEllipsize(TextUtils.TruncateAt.END);words.addView(title);TextView line=quiet(inbox.optString("preview"),12);line.setMaxLines(1);line.setEllipsize(TextUtils.TruncateAt.END);words.addView(line);row.addView(words,new LinearLayout.LayoutParams(0,-2,1));
      LinearLayout detail=column();detail.setGravity(Gravity.RIGHT);long at=inbox.optLong("at");detail.addView(quiet(at>0?new SimpleDateFormat("MM/dd HH:mm",Locale.CHINA).format(new Date(at)):"",10));int unread=inbox.optInt("unread");if(unread>0){TextView badge=text(unread>99?"99+":String.valueOf(unread),11);badge.setGravity(Gravity.CENTER);badge.setPadding(dp(5),0,dp(5),0);badge.setTextColor(Color.WHITE);badge.setBackground(rounded(0xffe94d55,10));badge.setContentDescription(unread+" 条未读消息");detail.addView(badge,new LinearLayout.LayoutParams(-2,dp(20)));}row.addView(detail,new LinearLayout.LayoutParams(-2,-2));
      row.setOnClickListener(v->selectConversation(id));LinearLayout.LayoutParams spacing=new LinearLayout.LayoutParams(-1,-2);spacing.bottomMargin=dp(12);content.addView(row,spacing);}}
    catch(Exception e){content.addView(quiet("暂时无法读取聊天列表，已有聊天仍保留。",12));}
    TextView tip=quiet("在电脑端添加聊天和配置人格，手机会同步显示。",11);tip.setPadding(dp(8),dp(20),dp(8),0);content.addView(tip);scroll.addView(content);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));bottomTabs(false);scroll.post(()->{if(conversationScroll==scroll)scroll.scrollTo(0,previousY);});}
  private void settings(){reset("settings");toolbar("我的空间","连接与聊天设置",this::chat,this::chat);ScrollView scroll=new ScrollView(this);LinearLayout body=column();body.setPadding(dp(16),dp(18),dp(16),dp(18));LinearLayout profile=column();profile.setPadding(dp(20),dp(20),dp(20),dp(20));profile.setBackground(rounded(0xffe9f2ff,15));profile.addView(text("fish with me",20));profile.addView(quiet("一份自己的档案，一段熟悉的陪伴。",12));body.addView(profile);settingRow(body,"我的资料","头像、昵称、个性签名与地区",()->ProfileData.open(this,"self"));body.addView(quiet("聊天",12));settingRow(body,"聊天记录","在聊天中查看更早记录",this::history);settingRow(body,"查找聊天","关键词、日期与附件类型",this::findHistory);settingRow(body,"外观","主题色、背景、字号与气泡预览",()->Appearance.open(this,store,()->{blue=Appearance.accent(store);canvas=Appearance.background(store);settings();}));settingRow(body,"存储管理","查看和清理可重新下载的媒体缓存",this::cacheSettings);body.addView(quiet("连接",12));settingRow(body,"连接状态",store.readMeta("status","尚未连接"),this::startSync);settingRow(body,"后台与电池","后台连接、通知和电池权限",this::backgroundSettings);settingRow(body,"暂停后台连接","暂停后仍保留本机聊天和待发消息",()->{ConnectionRecovery.pause(this);store.meta("status","后台连接已暂停");settings();});settingRow(body,"重新配对","更换电脑或恢复档案后使用",()->new AlertDialog.Builder(this).setMessage("重新配对会暂停当前后台连接。聊天和待发内容仍会保留。").setNegativeButton("取消",null).setPositiveButton("继续",(d,n)->{ConnectionRecovery.pause(this);pairing();}).show());body.addView(quiet("关于",12));settingRow(body,"本机诊断","发生异常时导出，不包含聊天正文",this::exportDiagnostics);body.addView(quiet("fish with me 0.4.8 · 私人连接 · 本地保存",11));scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));bottomTabs(true);}
  private void backgroundSettings(){
    reset("background");toolbar("后台与电池","保持私人消息连接",this::settings,this::settings);
    ScrollView scroll=new ScrollView(this);LinearLayout body=column();body.setPadding(dp(18),dp(18),dp(18),dp(18));
    body.addView(text("后台收消息",20));body.addView(quiet("手机需要保持与电脑的私人连接。电脑服务和 Tailscale 也需要在线。",13));
    settingRow(body,"后台连接",ConnectionRecovery.enabled(this)?"已开启 · 后台运行仍受系统管理":"已暂停 · 点击恢复",()->{startSync();backgroundSettings();});
    boolean unrestricted=getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    settingRow(body,"允许持续后台运行",unrestricted?"已允许，不受系统电池优化限制":"尚未允许 · 点击申请",()->{
      Intent request=new Intent(unrestricted?Settings.ACTION_APPLICATION_DETAILS_SETTINGS:Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:"+getPackageName()));
      try{startActivity(request);}catch(ActivityNotFoundException error){startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));}
    });
    settingRow(body,"消息通知",MessageNotifications.enabled(this)?"新消息已允许 · 点击管理":"新消息未允许 · 点击开启",()->startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID,"messages")));
    settingRow(body,"测试通知","立即测试或 20 秒后测试后台，不发送聊天",()->new AlertDialog.Builder(this).setTitle("本机通知测试").setItems(new String[]{"立即测试通知","20 秒后测试后台"},(dialog,which)->{
      getSharedPreferences("runtime",0).edit().putBoolean("enabled",true).commit();
      try{startForegroundService(new Intent(this,SyncService.class).setAction("test-notification").putExtra("testDelayMs",which==0?0L:20000L));Toast.makeText(this,which==0?"正在显示本机测试通知":"20 秒后测试通知，可划掉聊天窗口观察",Toast.LENGTH_LONG).show();}catch(RuntimeException error){failure(error);}
    }).show());
    settingRow(body,"自启动与关联启动","尝试打开 vivo / iQOO 自启动管理",()->new AlertDialog.Builder(this).setTitle("允许系统恢复后台连接").setMessage("点击“打开自启动管理”后，在系统页面找到 fish with me，开启自启动和关联启动。这与已允许的后台高耗电是不同设置。\n\n若系统没有提供直达页面，会打开系统设置；可搜索“自启动”，或进入：应用与权限 → 权限管理 → 权限 → 自启动。\n\n打开页面不代表权限已开启。部分系统即使允许后台运行，划掉任务仍可能终止应用；暂时可在最近任务里下滑 fish with me 卡片加锁。")
      .setPositiveButton("打开自启动管理",(d,n)->{boolean direct=AutoStartSettings.open(this);BackgroundDiagnostics.event(this,direct?"autostart_page_opened":"autostart_page_fallback");if(!direct)Toast.makeText(this,"系统未提供可用的直达入口，请在设置里搜索自启动",Toast.LENGTH_LONG).show();}).setNeutralButton("应用详情",(d,n)->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())))).setNegativeButton("关闭",null).show());
    settingRow(body,"系统后台管理","检查自启动、后台活动和省电限制",()->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:"+getPackageName()))));
    body.addView(quiet("部分手机还需要在系统设置中允许自启动、后台活动，并在最近任务中锁定 fish with me。Tailscale 也需要允许后台运行。",13));
    body.addView(quiet("普通划掉窗口会尝试保持连接；强行停止或系统深度清理仍可能中断，重新打开应用可恢复同步。",13));
    scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
  }
  @Override public void onBackPressed(){if(screen.equals("chat"))conversations();else if(screen.equals("settings"))chat();else if(screen.equals("background"))settings();else super.onBackPressed();}
  private void failure(Exception error) { runOnUiThread(() -> new AlertDialog.Builder(this).setTitle("操作未完成").setMessage("资料已保留。请检查私人连接、电脑服务与设备授权后重试。\n" + safeError(error.getMessage())).setPositiveButton("知道了", null).show()); }
  private String safeError(String code) { if (code == null) return ""; if(code.equals("RECORDING_TOO_SHORT"))return "录音太短，请说话至少半秒后再结束。";if(code.equals("RECORDING_FAILED")||code.equals("MIC_UNAVAILABLE"))return "录音未完成，请检查麦克风权限或其他应用是否占用麦克风，再重新录制。"; if (code.matches("[A-Z_0-9]{1,60}")) return code; return "连接或本机存储未就绪"; }
  private void work(Task task) { work(task,null); }
  private void work(Task task,Runnable cleanup) { SyncService.WORK.execute(() -> { try { task.run(); } catch (Exception error) { failure(error); } finally {if(cleanup!=null)runOnUiThread(cleanup);} }); }
  interface Task { void run() throws Exception; }
  private void pairing() {
    draft = null; timeline = null; base("连接你的小鲸鱼");
    root.addView(text("电脑和手机先连接同一私人网络，再填写电脑的 HTTPS 地址和配对凭据。", 14));
    EditText address = new EditText(this); address.setBackgroundTintList(ColorStateList.valueOf(blue));address.setTextSize(14);address.setSingleLine(true); address.setHint("https://电脑名称:端口"); if (config != null) address.setText(config.optString("url")); root.addView(address);
    EditText credential = new EditText(this); credential.setBackgroundTintList(ColorStateList.valueOf(blue));credential.setTextSize(14);credential.setHint("电脑显示的配对凭据"); credential.setInputType(129); root.addView(credential);
    EditText name = new EditText(this); name.setBackgroundTintList(ColorStateList.valueOf(blue));name.setTextSize(14);name.setSingleLine(true); name.setText("我的 Android 手机"); root.addView(name);
    Button pair = button("配对并连接", () -> {
      if(pairingBusy)return; pairingBusy=true;
      String url = address.getText().toString(), ticket = credential.getText().toString().trim(), label = name.getText().toString().trim();
      work(() -> {
        JSONObject saved = Secrets.load(this); JSONObject candidate;
        if (saved != null && !saved.has("deviceId") && saved.optString("credential").equals(ticket) && saved.optString("url").equals(Api.validOrigin(url))) candidate = saved;
        else { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); StringBuilder token = new StringBuilder(); for (byte value : bytes) token.append(String.format("%02x", value & 255)); candidate = new JSONObject().put("url", Api.validOrigin(url)).put("token", token.toString()).put("credential", ticket).put("name", label); Secrets.save(this, candidate); }
        Api api = new Api(candidate); JSONObject identity;
        try { identity = api.object("/v1/bootstrap", null); }
        catch (Exception error) { if (!"DEVICE_AUTH_REQUIRED".equals(error.getMessage())) throw error; identity = api.object("/v1/pairing/claim", new JSONObject().put("credential", ticket).put("deviceToken", candidate.getString("token")).put("name", label)); }
        candidate.put("deviceId", identity.getString("deviceId")); candidate.remove("credential"); Secrets.save(this, candidate); config = candidate;
        runOnUiThread(() -> { chat(); startSync(); });
      },()->pairingBusy=false);
    }); root.addView(pair);
    root.addView(text("设备凭据由 Android 密钥库保护。应用不接受明文地址或忽略证书校验。", 13));
    if (config != null && config.has("deviceId")) root.addView(button("返回现有聊天", this::chat));
  }
  private void startSync() {
    getSharedPreferences("runtime",0).edit().putBoolean("enabled",true).apply();
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 3);
    try { startForegroundService(new Intent(this, SyncService.class)); } catch (RuntimeException error) { failure(error); }
  }
  private void chat(){
    reset("chat");toolbar(store.readMeta("chatName",ProfileData.read(store,"agent").optString("nickname","小鲸鱼")),"正在同步私人空间…",this::conversations,this::settings);
    replyActivityBar=new LinearLayout(this);replyActivityBar.setGravity(Gravity.CENTER_VERTICAL);replyActivityBar.setPadding(dp(14),0,dp(10),0);replyActivityLabel=quiet("",12);replyActivityBar.addView(replyActivityLabel,new LinearLayout.LayoutParams(0,-2,1));replyActivityBar.setVisibility(View.GONE);root.addView(replyActivityBar);
    FrameLayout messageArea=new FrameLayout(this);
    chatScroll=new PinnedScrollView(this);chatScroll.setFillViewport(true);chatScroll.setClipToPadding(false);chatScroll.setPadding(dp(13),0,dp(13),0);timeline=column();timelineViews=new TimelineViews(timeline);timeline.setPadding(0,dp(12),0,dp(14));chatScroll.addView(timeline);messageArea.addView(chatScroll,new FrameLayout.LayoutParams(-1,-1));root.addView(messageArea,new LinearLayout.LayoutParams(-1,0,1));
    pendingScroll=new ScrollView(this);pending=column();pending.setPadding(dp(16),0,dp(16),0);pendingScroll.addView(pending);pendingScroll.setVisibility(View.GONE);root.addView(pendingScroll,new LinearLayout.LayoutParams(-1,dp(84)));
    LinearLayout composeArea=column();composeArea.setPadding(dp(8),dp(8),dp(8),dp(8));composeArea.setBackgroundColor(0xfff8f9fb);
    try{draftFiles=new JSONArray(store.readMeta("draftFiles","[]"));}catch(Exception ignored){draftFiles=new JSONArray();}
    voiceMode=store.readMeta("voiceMode","false").equals("true");
    recordingStatus=text("",13);recordingStatus.setGravity(Gravity.CENTER);recordingStatus.setVisibility(View.GONE);composeArea.addView(recordingStatus);
    playbackPosition=text("",12);playbackPosition.setGravity(Gravity.CENTER);playbackPosition.setVisibility(View.GONE);playbackPosition.setSingleLine(true);playbackPosition.setPadding(dp(12),dp(5),dp(12),dp(5));playbackPosition.setTextColor(Color.WHITE);playbackPosition.setBackground(rounded(0xdd26364d,14));
    FrameLayout.LayoutParams previewLayout=new FrameLayout.LayoutParams(-2,-2,Gravity.BOTTOM|Gravity.CENTER_HORIZONTAL);previewLayout.bottomMargin=dp(8);messageArea.addView(playbackPosition,previewLayout);
    fileStatus=quiet("",12);fileStatus.setOnClickListener(v->attachmentsMenu());composeArea.addView(fileStatus);
    LinearLayout compose=new LinearLayout(this);compose.setGravity(Gravity.BOTTOM);
    inputToggle=new ComposerIcon(this,"voice");inputToggle.setOnClickListener(v->toggleInput());compose.addView(inputToggle,new LinearLayout.LayoutParams(dp(48),dp(48)));
    draft=new EditText(this);draft.setHint("");draft.setTextSize(16);draft.setTextColor(ink);draft.setMaxLines(4);draft.setMinLines(1);draft.setPadding(dp(10),dp(10),dp(10),dp(10));draft.setBackground(rounded(Color.WHITE,12));draft.setText(store.readMeta("draft",""));draft.setSaveEnabled(false);
    LinearLayout.LayoutParams edit=new LinearLayout.LayoutParams(0,-2,1);edit.leftMargin=dp(3);edit.rightMargin=dp(3);compose.addView(draft,edit);
    holdButton=button("按住说话",()->{});holdButton.setTextColor(0xff222222);holdButton.setTextSize(16);holdButton.setBackground(rounded(Color.WHITE,12));holdButton.setContentDescription("按住说话，松开发送，上滑取消");LinearLayout.LayoutParams holdLayout=new LinearLayout.LayoutParams(0,dp(48),1);holdLayout.leftMargin=dp(3);holdLayout.rightMargin=dp(3);compose.addView(holdButton,holdLayout);
    holdButton.setOnTouchListener((v,event)->{
      switch(event.getActionMasked()){
        case MotionEvent.ACTION_DOWN:
          if(recordVoice()){holdGesture.begin(event.getRawY());v.getParent().requestDisallowInterceptTouchEvent(true);showRecording(0);}return true;
        case MotionEvent.ACTION_MOVE:
          if(recorder!=null){holdGesture.move(event.getRawY(),dp(64));showRecording((SystemClock.elapsedRealtime()-recordingStarted)/1000);}return true;
        case MotionEvent.ACTION_UP:
          boolean sendVoice=holdGesture.finish();finishRecording(sendVoice);v.getParent().requestDisallowInterceptTouchEvent(false);return true;
        case MotionEvent.ACTION_CANCEL:case MotionEvent.ACTION_POINTER_DOWN:
          finishRecording(false);v.getParent().requestDisallowInterceptTouchEvent(false);return true;
        default:return true;
      }
    });
    ComposerIcon stickerButton=new ComposerIcon(this,"sticker");stickerButton.setContentDescription("表情");stickerButton.setOnClickListener(v->openStickers());compose.addView(stickerButton,new LinearLayout.LayoutParams(dp(44),dp(48)));
    sendButton=primary("发送",this::send);sendButton.setPadding(dp(10),0,dp(10),0);sendButton.setBackground(new RippleDrawable(ColorStateList.valueOf(0x263478e5),new InsetDrawable(rounded(Appearance.action(blue),17),0,dp(7),0,dp(7)),null));LinearLayout.LayoutParams sendLayout=new LinearLayout.LayoutParams(dp(56),dp(48));sendLayout.leftMargin=dp(6);sendLayout.rightMargin=dp(3);sendLayout.bottomMargin=dp(2);compose.addView(sendButton,sendLayout);
    attachmentButton=new ComposerIcon(this,"plus");attachmentButton.setContentDescription("添加附件");attachmentButton.setOnClickListener(v->attachmentsMenu());compose.addView(attachmentButton,new LinearLayout.LayoutParams(dp(48),dp(48)));
    draft.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){store.meta("draft",s.toString());updateComposer();}public void afterTextChanged(android.text.Editable value){}});
    composeArea.addView(compose);root.addView(composeArea);updateFiles();updateComposer();
    try{render();}catch(Exception error){failure(error);}updateMessageVisibility();
  }
  private void send() {
    String content = draft.getText().toString(); if (content.trim().isEmpty() && draftFiles.length() == 0) return;
    try {
      if(recorder!=null)throw new Exception("RECORDING_IN_PROGRESS");
      if(fileImporting)throw new Exception("FILE_IMPORT_IN_PROGRESS");
      if (store.readMeta("epoch", "").isEmpty()) throw new Exception("FIRST_SYNC_REQUIRED");
      if (content.length() > 32000) throw new Exception("MESSAGE_TOO_LONG");
      JSONArray ids = new JSONArray(); for (int i=0;i<draftFiles.length();i++) ids.put(draftFiles.getJSONObject(i).getString("id"));
      JSONObject message = new JSONObject().put("clientMessageId", UUID.randomUUID().toString()).put("deviceId", config.getString("deviceId")).put("text", content).put("queuedAt", System.currentTimeMillis()).put("expectedMode", store.readMeta("mode", "social")).put("expectedModeRevision", Long.parseLong(store.readMeta("modeRevision", "0"))).put("epoch", store.readMeta("epoch", "")).put("localState", "queued").put("files", draftFiles).put("attachmentIds", ids);
      store.queueDraft(message);chatScroll.followLatest(); getSharedPreferences("runtime",0).edit().putBoolean("enabled",true).apply();startForegroundService(new Intent(this, SyncService.class).setAction("send-now")); draft.setText(""); draftFiles = new JSONArray(); updateFiles(); rendered = ""; render();
    } catch (Exception error) { failure(error); }
  }
  private void openStickers(){
    try{final JSONObject savedConfig=new JSONObject(config.toString());final LocalStore chatStore=store;
      stickersDialog=new StickersDialog(this,savedConfig,sticker->{
        if(chatStore.readMeta("epoch","").isEmpty())throw new Exception("FIRST_SYNC_REQUIRED");JSONObject file=new Api(savedConfig).object("/v1/stickers/"+sticker.getString("id")+"/use",new JSONObject());file.remove("sticker");
        JSONObject message=new JSONObject().put("clientMessageId",UUID.randomUUID().toString()).put("deviceId",savedConfig.getString("deviceId")).put("text","").put("queuedAt",System.currentTimeMillis()).put("expectedMode",chatStore.readMeta("mode","social")).put("expectedModeRevision",Long.parseLong(chatStore.readMeta("modeRevision","0"))).put("epoch",chatStore.readMeta("epoch","")).put("localState","queued").put("files",new JSONArray().put(file)).put("attachmentIds",new JSONArray().put(file.getString("id")));
        chatStore.pending(message);runOnUiThread(()->{getSharedPreferences("runtime",0).edit().putBoolean("enabled",true).apply();try{startForegroundService(new Intent(this,SyncService.class).setAction("send-now"));if(store==chatStore)chatScroll.followLatest();rendered="";render();}catch(Exception error){failure(error);}});
      },()->{if(!PhotoPicker.multiple(this,7))Toast.makeText(this,"无法打开相册，请稍后重试",Toast.LENGTH_LONG).show();});stickersDialog.show();
    }catch(Exception error){failure(error);}
  }
  private void importStickers(Intent data){
    if(fileImporting)return;fileImporting=true;final List<Uri> selected=new ArrayList<>();if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)selected.add(data.getClipData().getItemAt(i).getUri());else if(data.getData()!=null)selected.add(data.getData());
    work(()->{Api api=new Api(config);int completed=0;for(Uri uri:selected){String name="表情.png";try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}File folder=new File(getFilesDir(),"media");folder.mkdirs();File temp=File.createTempFile("sticker-",".tmp",folder);try{
      try(InputStream in=getContentResolver().openInputStream(uri);FileOutputStream out=new FileOutputStream(temp)){byte[] buffer=new byte[65536];int n;long total=0;while((n=in.read(buffer))!=-1){total+=n;if(total>64L*1024*1024)throw new IOException("FILE_LIMIT");out.write(buffer,0,n);}out.getFD().sync();}
      String hash=Files.hash(temp);JSONObject file=new JSONObject().put("id",UUID.randomUUID().toString()).put("name",name).put("bytes",temp.length()).put("sha256",hash);JSONObject remote=api.object("/v1/attachments",file);
      try(RandomAccessFile input=new RandomAccessFile(temp,"r")){long offset=remote.optLong("offset");while(offset<temp.length()){input.seek(offset);byte[] chunk=new byte[(int)Math.min(1024*1024,temp.length()-offset)];input.readFully(chunk);JSONObject next=new JSONObject(new String(api.exchange("/v1/attachments/"+file.getString("id")+"/content?offset="+offset,"PUT",chunk,"application/octet-stream"),"UTF-8"));long value=next.getLong("offset");if(value<=offset||value>temp.length())throw new IOException("INVALID_UPLOAD_OFFSET");offset=value;}}
      api.object("/v1/attachments/"+file.getString("id")+"/complete",new JSONObject());api.object("/v1/stickers",new JSONObject().put("attachmentId",file.getString("id")).put("caption",name.replaceFirst("\\.[^.]+$", "")));completed++;
    }finally{temp.delete();}}final int count=completed;runOnUiThread(()->{fileImporting=false;Toast.makeText(this,"已导入 "+count+" 张表情",Toast.LENGTH_SHORT).show();openStickers();});},()->fileImporting=false);
  }
  private void render() throws Exception{
    if(timeline==null||draft==null)return;String connection=store.readMeta("status","正在连接");status.setText(connection.startsWith("已连接")?"● 已连接 · 私人会话":connection);
    TextView heading=root.findViewWithTag("screen-title");if(heading!=null)heading.setText(store.readMeta("chatName",ProfileData.read(store,"agent").optString("nickname","小鲸鱼")));
    renderReplyActivity();
    if(chatScroll.positionPinned())return;final int font=Appearance.font(store),radius=Appearance.radius(store);String epoch=store.readMeta("epoch","");if(!epoch.equals(arrivalEpoch)){arrivals.reset();arrivalEpoch=epoch;rendered="";}
    localMore=false;List<JSONObject> messages=new ArrayList<>(),queue=store.pending();Map<String,JSONObject> merged=new LinkedHashMap<>();for(JSONObject row:historyRows)merged.put(row.optString("id"),row);if(historyQuery.isEmpty()&&historyDate.isEmpty()&&historyType.isEmpty()){List<JSONObject> cached=store.messages(localMessageLimit+1);localMore=cached.size()>localMessageLimit&&localMessageLimit<200;if(cached.size()>localMessageLimit)cached.remove(0);for(JSONObject row:cached)merged.put(row.optString("id"),row);}messages.addAll(merged.values());for(JSONObject item:queue){boolean exists=false;for(JSONObject row:messages)if(item.optString("clientMessageId").equals(row.optString("client_id"))&&item.optString("deviceId").equals(row.optString("device"))){exists=true;break;}if(!exists){String content=item.optString("text");if(content.isEmpty())content="语音或附件";messages.add(new JSONObject().put("id","local-"+item.optString("clientMessageId")).put("role","user").put("text",content).put("created_at",item.optLong("queuedAt")).put("state",item.optString("localState")).put("_local",item));}}Collections.sort(messages,(a,b)->{int c=Long.compare(a.optLong("created_at"),b.optLong("created_at"));if(c!=0)return c;String ak=a.has("source")?a.optString("id"):"live-"+String.format(Locale.ROOT,"%020d",a.optLong("seq"))+"-"+a.optString("id"),bk=b.has("source")?b.optString("id"):"live-"+String.format(Locale.ROOT,"%020d",b.optLong("seq"))+"-"+b.optString("id");return c!=0?c:ak.compareTo(bk);});String signature=messages.toString()+queue.toString()+store.readMeta("profiles","")+":"+font+":"+radius+":"+blue+":"+getResources().getDisplayMetrics().widthPixels;if(signature.equals(rendered)&&!arrivals.ready(System.currentTimeMillis()))return;
    List<String> initialIds=new ArrayList<>();for(JSONObject item:messages)initialIds.add(item.optString("id"));arrivals.prime(initialIds);
    final int previousScrollY=chatScroll.getScrollY();boolean bottom=timeline.getChildCount()==0||chatScroll.nearBottom(dp(100));rendered=signature;pending.removeAllViews();
    timelineViews.begin(store.readMeta("profiles","")+":"+font+":"+radius+":"+blue+":"+getResources().getDisplayMetrics().widthPixels);
    String olderText=localMore||historyMore?"查看更早的消息":"已到最早的消息";if(!timelineViews.reuse("older",olderText)){Button older=button(olderText,this::history);older.setTextColor(muted);older.setTextSize(11);older.setBackgroundColor(Color.TRANSPARENT);LinearLayout.LayoutParams olderParams=new LinearLayout.LayoutParams(-2,dp(36));olderParams.gravity=Gravity.CENTER;older.setLayoutParams(olderParams);timelineViews.put("older",olderText,older);}
    long previous=0;SimpleDateFormat format=new SimpleDateFormat("MM月dd日 HH:mm",Locale.CHINA);
    for(JSONObject message:messages){if(MessagePresentation.hidden(message.optString("device"),message.optString("client_id")))continue;int arrival=arrivals.state(message.optString("id"),message.optString("role").equals("assistant")&&!message.has("source")&&historyQuery.isEmpty()&&historyDate.isEmpty()&&historyType.isEmpty(),message.optLong("created_at"),System.currentTimeMillis());if(arrival<0)continue;String key=message.optString("id");long at=message.optLong("created_at");if(at-previous>5*60000){String label=format.format(new Date(at));if(!timelineViews.reuse("date:"+key,label)){TextView date=quiet(label,12);date.setGravity(Gravity.CENTER);date.setPadding(0,dp(10),0,dp(16));timelineViews.put("date:"+key,label,date);}}previous=at;
      JSONObject source=message.optJSONObject("source");if(source!=null){String origin="\u5bfc\u5165 "+source.optString("sourceId")+" / "+source.optString("scope");if(source.optBoolean("unknownTime"))origin+=" / \u65f6\u95f4\u4e0d\u8be6";JSONArray missing=source.optJSONArray("missingAttachments");if(missing!=null&&missing.length()>0)origin+=" / \u7f3a\u5931\u9644\u4ef6 "+missing.length();if(!timelineViews.reuse("source:"+key,origin))timelineViews.put("source:"+key,origin,quiet(origin,10));}
      String rowSignature=message.toString();JSONArray rowFiles=message.optJSONArray("attachments");if(rowFiles!=null)for(int i=0;i<rowFiles.length();i++)rowSignature+="\n"+store.readMeta("transcript:"+rowFiles.getJSONObject(i).optString("sha256"),"");if(timelineViews.reuse("message:"+key,rowSignature))continue;
      boolean mine=message.optString("role").equals("user");LinearLayout row=new LinearLayout(this);row.setGravity(mine?Gravity.RIGHT:Gravity.LEFT);LinearLayout bubble=column();bubble.setPadding(dp(14),dp(10),dp(14),dp(10));bubble.setBackground(rounded(mine?Appearance.bubble(blue):Color.WHITE,radius));int max=(int)(getResources().getDisplayMetrics().widthPixels*.65f);
      JSONArray voiceFiles=message.optJSONArray("attachments");boolean voiceOnly=voiceFiles!=null&&voiceFiles.length()>0&&(message.optString("text").isEmpty()||(MessagePresentation.voiceCaption(message.optString("device"),message.optString("client_id"),message.optString("text"))||MessagePresentation.memeCaption(message.optString("device"),message.optString("client_id"),message.optString("text"))));if(voiceOnly){bubble.setPadding(0,0,0,0);bubble.setBackgroundColor(Color.TRANSPARENT);}
      String content=(MessagePresentation.voiceCaption(message.optString("device"),message.optString("client_id"),message.optString("text"))||MessagePresentation.memeCaption(message.optString("device"),message.optString("client_id"),message.optString("text")))?"":message.optString("text");if(!content.isEmpty()){TextView body=text(content,font);body.setMaxWidth(max);body.setTextIsSelectable(true);body.setLineSpacing(dp(3),1);bubble.addView(body);}
      JSONArray files=message.optJSONArray("attachments");if(files!=null)for(int i=0;i<files.length();i++){JSONObject attachment=files.getJSONObject(i);if(attachment.optString("mediaType").startsWith("image/")){bubble.addView(imageAttachment(attachment,Math.min(max,dp(240))));}else if(attachment.optString("mediaType").startsWith("audio/")){VoiceBar voice=voiceBar(attachment,mine);LinearLayout.LayoutParams bar=new LinearLayout.LayoutParams(Math.min(max,dp(174)),dp(48));bar.topMargin=i>0?dp(5):0;bubble.addView(voice,bar);appendTranscript(bubble,attachment,max);}else{Button file=button(attachment.getString("name")+"\n"+String.format(Locale.CHINA,"%.1f KiB · 点击打开",attachment.optLong("bytes")/1024.0),()->openFile(attachment));file.setMaxWidth(max);file.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);file.setTextSize(14);bubble.addView(file);}}
      String state=message.optString("state");if(!state.equals("completed")&&!state.equals("queued")&&!state.equals("running")){TextView stateView=quiet(stateLabel(state),12);stateView.setMaxWidth(max);bubble.addView(stateView);}
      if(state.equals("awaiting_confirmation")||state.equals("confirmation"))bubble.addView(button("确认继续",()->messageDecision(message,"confirm")));
      if(state.equals("queued")||state.equals("awaiting_confirmation")||state.equals("confirmation"))row.setOnLongClickListener(v->{new AlertDialog.Builder(this).setItems(new String[]{"取消发送"},(dialog,index)->messageDecision(message,"cancel")).show();return true;});
      View face=avatar(mine);LinearLayout.LayoutParams image=new LinearLayout.LayoutParams(dp(36),dp(36)),card=new LinearLayout.LayoutParams(-2,-2);if(mine){card.rightMargin=dp(9);row.addView(bubble,card);row.addView(face,image);}else{card.leftMargin=dp(9);row.addView(face,image);row.addView(bubble,card);}LinearLayout.LayoutParams line=new LinearLayout.LayoutParams(-1,-2);line.bottomMargin=dp(16);row.setLayoutParams(line);timelineViews.put("message:"+key,rowSignature,row);if(arrival==1&&android.animation.ValueAnimator.areAnimatorsEnabled()){row.setAlpha(0f);row.setTranslationY(dp(8));row.animate().alpha(1f).translationY(0f).setDuration(220).start();}
    }
    timelineViews.end();for(java.util.Iterator<android.graphics.drawable.Animatable> it=stickerAnimations.iterator();it.hasNext();){android.graphics.drawable.Animatable animation=it.next();android.graphics.drawable.Drawable.Callback callback=((android.graphics.drawable.Drawable)animation).getCallback();if(!(callback instanceof View)||!((View)callback).isAttachedToWindow()){animation.stop();it.remove();}}pendingScroll.setVisibility(View.GONE);
    chatScroll.restoreAfterLayout(bottom,previousScrollY);
  }
  private String stateLabel(String state) { switch (state) { case "queued": return "已保存 · 等待处理"; case "confirmation": case "awaiting_confirmation": return "待发消息需要确认"; case "cancel_requested": return "待联网核对取消"; case "unknown": return "结果待核对 · 不自动重发"; case "running": return "正在处理"; case "cancelled": return "已取消"; default: return "已同步"; } }
  private void messageDecision(JSONObject message,String action){JSONObject local=message.optJSONObject("_local");if(local==null){decision(message,action);return;}work(()->{JSONObject current=store.pending(local.getString("clientMessageId"));if(current==null)return;if(action.equals("confirm"))current.put("confirmedAt",System.currentTimeMillis()).put("localState","queued").put("expectedMode",store.readMeta("mode","social")).put("expectedModeRevision",Long.parseLong(store.readMeta("modeRevision","0")));else current.put("localState","cancel_requested");store.pending(current);});}
  private void decision(JSONObject message, String action) { work(() -> { JSONObject result = new Api(config).object("/v1/messages/" + message.getString("id") + "/decision", new JSONObject().put("revision", message.getLong("revision")).put("action", action)); store.cache(new JSONArray().put(result)); }); }
  private void renderReplyActivity() throws Exception {
    if(replyActivityBar==null)return;
    JSONObject value=new JSONObject(store.readMeta("replyActivity","{}"));String state=value.optString("state","idle");
    boolean fresh=System.currentTimeMillis()-Long.parseLong(store.readMeta("replyActivityAt","0"))<5000;
    String label=state.equals("queued")?"收到消息":state.equals("working")||state.equals("sending")?"正在输入…":"";
    replyActivityBar.setVisibility(fresh&&!label.isEmpty()?View.VISIBLE:View.GONE);replyActivityLabel.setText(fresh?label:"");
  }
  protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request,result,data);if(request==7&&result==RESULT_OK&&data!=null){importStickers(data);return;} if (request != 4 || result != RESULT_OK || data == null || fileImporting) return;
    final List<Uri> selected;try{selected=AttachmentSelection.read(data,8-draftFiles.length());}catch(IllegalArgumentException error){Toast.makeText(this,"最多添加 8 个附件，原有附件已保留",Toast.LENGTH_LONG).show();return;}if(selected.isEmpty())return;
    final LocalStore targetStore=store;final String existing=draftFiles.toString();fileImporting=true;
    work(() -> {JSONArray next=new JSONArray(existing);for(Uri uri:selected)next.put(prepareAttachment(uri));targetStore.meta("draftFiles",next.toString());
      runOnUiThread(() -> {if(store==targetStore){draftFiles=next;updateFiles();}});
    },()->fileImporting=false);
  }
  private JSONObject prepareAttachment(Uri uri) throws Exception {
      String name = "附件"; try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null,null,null)) { if (cursor != null && cursor.moveToFirst()&&!cursor.isNull(0)) name=cursor.getString(0); }
      File folder = new File(getFilesDir(), "media"); folder.mkdirs(); File temp = File.createTempFile("upload-", ".tmp", folder); long bytes=0;
      try{
      try (InputStream input = getContentResolver().openInputStream(uri); FileOutputStream output = new FileOutputStream(temp)) { byte[] buffer=new byte[65536]; int count; while ((count=input.read(buffer))!=-1) { bytes+=count; if(bytes>64L*1024*1024) throw new Exception("FILE_LIMIT"); output.write(buffer,0,count); } output.getFD().sync(); }
      String digest=Files.hash(temp); File target=new File(folder,digest); if (!target.exists() && !temp.renameTo(target)) throw new Exception("FILE_SAVE_FAILED");
      JSONObject metadata=new JSONObject().put("id",UUID.randomUUID().toString()).put("name",name).put("bytes",bytes).put("sha256",digest);
      if(!Files.valid(target,metadata)) throw new Exception("FILE_HASH_MISMATCH");
      return metadata;
      }finally{if(temp.exists())temp.delete();}
  }
  private VoiceBar voiceBar(JSONObject metadata,boolean mine){return new VoiceBar(this,metadata.optString("id"),mine,metadata.optInt("durationMs",0),blue,Appearance.font(store),Appearance.radius(store),new VoiceBar.Actions(){
    public void play(){if(AudioPlayer.stopIfActive(metadata.optString("id"))){audioRequest++;return;}openFile(metadata,0);}
    public void menu(){new AlertDialog.Builder(MainActivity.this).setItems(new String[]{"转文字","从头播放"},(d,n)->{if(n==0){transcriptionRequests.put(metadata.optString("id"),metadata);pollTranscription(metadata,true);}else openFile(metadata,0);}).show();}
    public void seek(int position){openFile(metadata,position);}
    public void preview(int position,int duration){if(chatScroll!=null)chatScroll.pinPosition();handler.removeCallbacks(hidePlaybackPosition);if(playbackPosition!=null){playbackPosition.setText(String.format(Locale.CHINA,"拖动到 %.1f 秒 / %.1f 秒",position/1000.0,duration/1000.0));playbackPosition.setVisibility(View.VISIBLE);}}
    public void endPreview(){if(chatScroll!=null)chatScroll.releasePosition();handler.removeCallbacks(hidePlaybackPosition);handler.postDelayed(hidePlaybackPosition,1500);}
  });}
  private void appendTranscript(LinearLayout parent,JSONObject metadata,int max){String result=store.readMeta("transcript:"+metadata.optString("sha256"),"");if(!result.isEmpty()){TextView shown=text(result,14);shown.setMaxWidth(max);shown.setTextIsSelectable(true);shown.setPadding(dp(4),dp(8),dp(4),dp(4));parent.addView(shown);}}
  private void pollTranscription(JSONObject metadata,boolean start){
    String id=metadata.optString("id"),key="transcript:"+metadata.optString("sha256");if(!active||transcriptionPolling.contains(id))return;transcriptionPolling.add(id);
    if(start){store.meta(key,"正在转文字…");rendered="";try{render();}catch(Exception ignored){}}
    SyncService.WORK.execute(()->{
      JSONObject result;try{result=new Api(config).object("/v1/attachments/"+id+"/transcription",start?new JSONObject():null);}catch(Exception e){result=new JSONObject();try{result.put("state","connection-error");}catch(Exception ignored){}}
      final JSONObject response=result;runOnUiThread(()->{transcriptionPolling.remove(id);String state=response.optString("state");
        if(state.equals("completed")){store.meta(key,response.optString("text"));transcriptionRequests.remove(id);}
        else if(state.equals("queued")||state.equals("running")){store.meta(key,"正在转文字…");if(active&&!isFinishing()&&!isDestroyed())handler.postDelayed(()->pollTranscription(metadata,false),1500);}
        else{store.meta(key,state.equals("connection-error")?"转文字连接中断，请长按重新查看。":state.equals("unknown")?"转文字结果待核对，没有自动重试。":"这段语音未能可靠转成文字。");transcriptionRequests.remove(id);}
        if(active&&!isFinishing()&&!isDestroyed()){rendered="";try{render();}catch(Exception ignored){}}
      });
    });
  }
  private File cachedAttachment(JSONObject metadata) throws Exception {
    if(!metadata.getString("sha256").matches("[a-f0-9]{64}")||!metadata.getString("id").matches("[a-f0-9-]{36}"))throw new Exception("INVALID_ATTACHMENT"); File folder=new File(getFilesDir(),"media"); folder.mkdirs(); File file=new File(folder,metadata.getString("sha256"));
    if(!Files.valid(file,metadata)) { byte[] bytes=new Api(config).exchange("/v1/attachments/"+metadata.getString("id")+"/content","GET",null,null); File temp=File.createTempFile("download-",".tmp",folder); try(FileOutputStream output=new FileOutputStream(temp)){output.write(bytes);output.getFD().sync();} if(!Files.valid(temp,metadata)) throw new Exception("FILE_HASH_MISMATCH"); if(!temp.renameTo(file))throw new Exception("FILE_SAVE_FAILED"); }
    return file;
  }
  private Bitmap attachmentBitmap(File file,int limit) throws Exception {
    BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getPath(),options);
    if(options.outWidth<1||options.outHeight<1)throw new IOException("IMAGE_DECODE_FAILED");
    options.inSampleSize=1;while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>limit)options.inSampleSize*=2;
    options.inJustDecodeBounds=false;Bitmap image=BitmapFactory.decodeFile(file.getPath(),options);if(image==null)throw new IOException("IMAGE_DECODE_FAILED");
    Matrix matrix=new Matrix();int orientation=1;try{orientation=new ExifInterface(file.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION,1);}catch(IOException ignored){}
    if(orientation==3)matrix.postRotate(180);if(orientation==6)matrix.postRotate(90);if(orientation==8)matrix.postRotate(270);
    if(orientation==2||orientation==4)matrix.postScale(-1,1);if(orientation==4)matrix.postRotate(180);
    if(orientation==5||orientation==7){matrix.postRotate(orientation==5?90:270);matrix.postScale(-1,1);}
    return Bitmap.createBitmap(image,0,0,image.getWidth(),image.getHeight(),matrix,true);
  }
  private View imageAttachment(JSONObject metadata,int width){
    FrameLayout frame=new FrameLayout(this);frame.setLayoutParams(new LinearLayout.LayoutParams(width,dp(210)));frame.setBackground(rounded(Color.TRANSPARENT,12));frame.setClipToOutline(true);frame.setContentDescription("查看图片："+metadata.optString("name"));frame.setFocusable(true);
    ImageView image=new ImageView(this);image.setScaleType(ImageView.ScaleType.FIT_CENTER);frame.addView(image,new FrameLayout.LayoutParams(-1,-1));
    TextView status=quiet("图片加载中…",13);status.setGravity(Gravity.CENTER);frame.addView(status,new FrameLayout.LayoutParams(-1,-1));
    Runnable load=()->{status.setText("图片加载中…");SyncService.WORK.execute(()->{try{int bound=metadata.has("stickerId")?Math.min(width,dp(180)):width;android.graphics.drawable.Drawable drawable=StickerImages.decode(cachedAttachment(metadata),bound,dp(metadata.has("stickerId")?180:220));runOnUiThread(()->{if(isFinishing()||isDestroyed())return;int w=Math.max(1,drawable.getIntrinsicWidth()),h=Math.max(1,drawable.getIntrinsicHeight());float scale=Math.min(1f,Math.min((float)bound/w,(float)dp(metadata.has("stickerId")?180:220)/h));frame.setLayoutParams(new LinearLayout.LayoutParams(Math.round(w*scale),Math.round(h*scale)));image.setImageDrawable(drawable);if(drawable instanceof android.graphics.drawable.Animatable){stickerAnimations.add((android.graphics.drawable.Animatable)drawable);((android.graphics.drawable.Animatable)drawable).start();}status.setVisibility(View.GONE);frame.setOnClickListener(v->showImage(metadata));});}catch(Exception error){runOnUiThread(()->status.setText("图片加载失败 · 点击重试"));}});};
    frame.setOnClickListener(v->load.run());load.run();return frame;
  }
  private void showImage(JSONObject metadata){work(()->{android.graphics.drawable.Drawable drawable=StickerImages.decode(cachedAttachment(metadata),getResources().getDisplayMetrics().widthPixels,getResources().getDisplayMetrics().heightPixels);runOnUiThread(()->{if(!active||isFinishing()||isDestroyed())return;ImageView image=new ImageView(this);image.setImageDrawable(drawable);image.setScaleType(ImageView.ScaleType.FIT_CENTER);AlertDialog dialog=new AlertDialog.Builder(this).setTitle(metadata.optString("name")).setView(image).setPositiveButton("关闭",null).setNeutralButton("用其他应用打开",(d,n)->openFile(metadata)).create();dialog.setOnDismissListener(d->{if(drawable instanceof android.graphics.drawable.Animatable)((android.graphics.drawable.Animatable)drawable).stop();});dialog.show();if(drawable instanceof android.graphics.drawable.Animatable)((android.graphics.drawable.Animatable)drawable).start();});});}
  private void openFile(JSONObject metadata){openFile(metadata,0);}
  private void openFile(JSONObject metadata,int seekMs) { final boolean audio=metadata.optString("mediaType").startsWith("audio/");if(audio&&AudioPlayer.playCurrent(metadata.optString("id"),seekMs))return;final int ticket=++audioRequest;if(audio)AudioPlayer.loading(metadata.optString("id"));work(() -> {try{File file=cachedAttachment(metadata);
    String media=metadata.optString("mediaType","application/octet-stream");if(media.equals("application/octet-stream")){String name=metadata.optString("name"),ext=name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT);String inferred=android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);if(inferred!=null)media=inferred;}final String type=media;
    Uri uri=new Uri.Builder().scheme("content").authority(getPackageName()+".files").appendPath(metadata.getString("sha256")).appendQueryParameter("name",metadata.getString("name")).appendQueryParameter("type",type).build();
    runOnUiThread(() -> { if(audio){if(active&&ticket==audioRequest)AudioPlayer.play(file,metadata.optString("id"),seekMs);return;}try { startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); } catch(ActivityNotFoundException error){new AlertDialog.Builder(this).setMessage("文件已下载，手机没有可打开此类型的应用。").setPositiveButton("知道了",null).show();} });
  }catch(Exception error){if(audio)runOnUiThread(()->AudioPlayer.failed(metadata.optString("id")));throw error;} }); }
  private void exportDiagnostics() { new Thread(() -> {try{
    JSONObject report=new JSONObject().put("appVersion","0.4.8").put("backgroundEnabled",ConnectionRecovery.enabled(this)).put("batteryUnrestricted",getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName())).put("notificationsEnabled",getSystemService(NotificationManager.class).areNotificationsEnabled()).put("messageChannelImportance",MessageNotifications.channelImportance(this)).put("lastNoticeResult",LocalStore.get(this,"default").readMeta("lastNoticeResult","")).put("lastNoticeAt",LocalStore.get(this,"default").readMeta("lastNoticeAt","")).put("androidSdk",Build.VERSION.SDK_INT).put("pendingCount",store.pending().size()).put("cachedCount",store.messages().size()).put("status",store.readMeta("status", ""));
    report.put("background",BackgroundDiagnostics.snapshot(this));
    File crash=new File(getFilesDir(),"last-crash.json");
    if(crash.isFile()&&crash.length()<32768)try(InputStream input=new FileInputStream(crash)){ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);report.put("lastCrash",new JSONObject(output.toString("UTF-8")));}
    runOnUiThread(() -> new AlertDialog.Builder(this).setTitle("本机诊断（不含聊天正文或凭据）").setMessage(report.toString()).setPositiveButton("复制",(d,n)-> { android.content.ClipboardManager clipboard=getSystemService(android.content.ClipboardManager.class); clipboard.setPrimaryClip(ClipData.newPlainText("fish with me 诊断",report.toString())); }).setNegativeButton("关闭",null).show());
  }catch(Exception error){failure(error);}},"chatagent-diagnostics").start(); }
}

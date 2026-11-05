package local.chatagent.privatechat;

import android.app.*;
import android.content.*;
import android.os.*;
import android.content.pm.ServiceInfo;
import org.json.*;
import java.net.URLEncoder;
import java.util.*;
import java.util.concurrent.*;
import java.io.*;

public final class SyncService extends Service {
  static final ScheduledExecutorService WORK = Executors.newSingleThreadScheduledExecutor();
  private ScheduledFuture<?> loop;
  private NotificationManager notifications;
  public IBinder onBind(Intent intent) { return null; }
  public void onCreate() {
    super.onCreate(); notifications = getSystemService(NotificationManager.class);
    notifications.createNotificationChannel(new NotificationChannel("connection", "后台连接", NotificationManager.IMPORTANCE_LOW));
    notifications.createNotificationChannel(new NotificationChannel("messages", "小鲸鱼的新消息", NotificationManager.IMPORTANCE_DEFAULT));
  }
  private Notification notice(String channel, String title, String text) {
    return notice(channel,title,text,LocalStore.selected(this));
  }
  private Notification notice(String channel,String title,String text,String chatId){
    Intent intent=new Intent(this,MainActivity.class).putExtra("chatId",chatId).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);intent.setData(android.net.Uri.parse("chatagent://chat/"+chatId));
    PendingIntent open = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder=new Notification.Builder(this, channel).setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle(title).setContentText(text).setContentIntent(open).setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(channel.equals("messages")).setOngoing(channel.equals("connection"));
    if(channel.equals("messages"))builder.setStyle(new Notification.BigTextStyle().bigText(text));
    return builder.build();
  }
  public int onStartCommand(Intent intent, int flags, int startId) {
    Notification persistent = notice("connection", "小鲸鱼 · 后台连接", "通过私人连接同步消息");
    if (Build.VERSION.SDK_INT >= 34) startForeground(1, persistent, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING); else startForeground(1, persistent);
    getSharedPreferences("runtime", 0).edit().putBoolean("enabled", true).apply();
    if (loop == null) loop = WORK.scheduleWithFixedDelay(() -> { try { synchronize(); } catch (Exception error) {
      String code = error.getMessage();
      LocalStore.get(this).meta("status", "DEVICE_AUTH_REQUIRED".equals(code) ? "设备授权失效，请在电脑核对" : "连接中断 · 待发内容保留在本机");
      if ("DEVICE_AUTH_REQUIRED".equals(code)) { getSharedPreferences("runtime", 0).edit().putBoolean("enabled", false).apply(); stopSelf(); }
    } }, 0, 1, TimeUnit.SECONDS);
    if(intent!=null&&"send-now".equals(intent.getAction()))WORK.execute(()->{try{synchronize();}catch(Exception error){LocalStore.get(this).meta("status","连接中断 · 待发内容保留在本机");}});
    return START_STICKY;
  }
  public void onDestroy() { if (loop != null) loop.cancel(false); super.onDestroy(); }
  static String encode(String text) throws Exception { return URLEncoder.encode(text, "UTF-8"); }
  private void synchronize() throws Exception {
    JSONObject config = Secrets.load(this); if (config == null || !config.has("deviceId")) return;
    LocalStore catalog=LocalStore.get(this,"default");JSONArray chats;
    try{if(System.currentTimeMillis()-Long.parseLong(catalog.readMeta("chatListAt","0"))>15000){JSONObject result=new Api(config).object("/v1/chats",null);catalog.meta("chatList",result.getJSONArray("chats").toString());catalog.meta("chatListAt",String.valueOf(System.currentTimeMillis()));}}catch(Exception e){if(!"NOT_FOUND".equals(e.getMessage()))throw e;}
    chats=new JSONArray(catalog.readMeta("chatList","[{\"id\":\"default\",\"name\":\"小鲸鱼\"}]"));
    List<JSONObject> ordered=new ArrayList<>();for(int i=0;i<chats.length();i++)ordered.add(chats.getJSONObject(i));String selected=LocalStore.selected(this);ordered.sort((a,b)->Boolean.compare(!a.optString("id").equals(selected),!b.optString("id").equals(selected)));
    Exception failure=null;for(JSONObject chat:ordered){String id=chat.getString("id");LocalStore store=LocalStore.get(this,id);store.meta("chatName",chat.getString("name"));try{synchronizeChat(new JSONObject(config.toString()).put("chatId",id),store);}catch(Exception e){store.meta("status","连接中断 · 此聊天待发内容保留");failure=e;if("DEVICE_AUTH_REQUIRED".equals(e.getMessage()))throw e;}}
    if(failure!=null)throw failure;
  }
  private void synchronizeChat(JSONObject config,LocalStore store)throws Exception{
    Api api = new Api(config);
    boolean refreshAudioMetadata=!store.readMeta("audioMetadataVersion","").equals("1");
    JSONObject page = api.object("/v1/sync?epoch=" + encode(store.readMeta("epoch", "")) + "&after=" + (refreshAudioMetadata?"0":store.readMeta("cursor", "0")), null);
    Set<String> known = store.messageIds();
    store.sync(page);
    if(refreshAudioMetadata)store.meta("audioMetadataVersion","1");
    if (!page.optBoolean("reset")) for (int i = 0; i < page.getJSONArray("messages").length(); i++) {
      JSONObject row = page.getJSONArray("messages").getJSONObject(i);
      if (row.optString("role").equals("assistant") && !row.has("source") && !MessagePresentation.hidden(row.optString("device"),row.optString("client_id")) && !known.contains(row.getString("id"))) {
        try { MessageNotifications.post(this,store.chatId,row.getString("id"),notice("messages",store.readMeta("chatName","小鲸鱼"),LocalStore.preview(row),store.chatId)); } catch (SecurityException ignored) { store.meta("status", "通知权限未开启，消息仍已保存"); }
      }
    }
    for (JSONObject pending : store.pending()) {
      if (!config.getString("deviceId").equals(pending.optString("deviceId"))) { pending.put("localState", "unknown"); store.pending(pending); break; }
      Object found = api.call("/v1/messages/lookup?clientMessageId=" + encode(pending.getString("clientMessageId")), null);
      if (found instanceof JSONObject) {
        JSONObject row = (JSONObject) found;
        if (pending.optString("localState").equals("cancel_requested") && (row.optString("state").equals("queued") || row.optString("state").equals("awaiting_confirmation"))) row = api.object("/v1/messages/" + row.getString("id") + "/decision", new JSONObject().put("revision", row.getLong("revision")).put("action", "cancel"));
        store.cache(new JSONArray().put(row)); store.remove(pending.getString("clientMessageId")); continue;
      }
      String action = QueuePolicy.action(System.currentTimeMillis(), pending.getLong("queuedAt"), pending.optLong("confirmedAt"), pending.optString("epoch", null), store.readMeta("epoch", ""), pending.getString("expectedMode"), store.readMeta("mode", "social"), pending.getLong("expectedModeRevision"), Long.parseLong(store.readMeta("modeRevision", "0")), pending.optString("localState"));
      if (pending.optString("localState").equals("cancel_requested")) { if (!action.equals("unknown")) {store.remove(pending.getString("clientMessageId"));continue;} break; }
      if (!action.equals("send")) { pending.put("localState", action); store.pending(pending); break; }
      JSONArray files = pending.optJSONArray("files");
      if (files != null && files.length()>0) {
        try{for (int i = 0; i < files.length(); i++){pending.put("transferStatus","正在上传附件 "+(i+1)+"/"+files.length());store.pending(pending);upload(api, files.getJSONObject(i));}pending.put("transferStatus","上传完成 · 正在核对发送");store.pending(pending);}
        catch(Exception error){pending.put("transferStatus","上传未完成 · 原录音保留，连接恢复后续传");store.pending(pending);throw error;}
      }
      try { JSONObject accepted = api.object("/v1/messages", pending);
        if (accepted.optString("state").equals("awaiting_confirmation") && pending.optLong("confirmedAt") > 0 && System.currentTimeMillis()-pending.getLong("confirmedAt") <= 30*60000L) accepted = api.object("/v1/messages/"+accepted.getString("id")+"/decision",new JSONObject().put("revision",accepted.getLong("revision")).put("action","confirm"));
        store.cache(new JSONArray().put(accepted)); store.remove(pending.getString("clientMessageId")); }
      catch (Exception error) { if ("MODE_CHANGED".equals(error.getMessage())) { pending.put("localState", "confirmation"); store.pending(pending); break; } else throw error; }
    }
    // Send after epoch validation, before optional profile/history downloads.
    try{ProfileData.sync(api,store,store.readMeta("epoch",""));}catch(Exception ignored){}
    if (page.optBoolean("hasMore")) return;
    long before=Long.parseLong(store.readMeta("cacheBefore","0"));
    if(before>1){JSONObject cache=api.object("/v1/cache?epoch="+encode(store.readMeta("epoch",""))+"&before="+before+"&since="+store.readMeta("cacheSince","0"),null);store.cache(cache.getJSONArray("messages"));store.meta("cacheBefore",cache.optBoolean("hasMore")?String.valueOf(cache.getLong("nextBefore")):"0");}
    store.prune(System.currentTimeMillis()-30L*86400000); store.meta("status", "已连接 · 消息保存在自己的电脑");
  }
  private void upload(Api api, JSONObject metadata) throws Exception {
    JSONObject remote = api.object("/v1/attachments", metadata);
    if (remote.getString("state").equals("ready")) return;
    File file = new File(getFilesDir(), "media/" + metadata.getString("sha256"));
    if (!Files.valid(file, metadata)) throw new Exception("LOCAL_FILE_DAMAGED");
    try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
      long offset = remote.getLong("offset"); input.seek(offset);
      while (offset < file.length()) { byte[] bytes = new byte[(int) Math.min(1024 * 1024, file.length() - offset)]; input.readFully(bytes);
        JSONObject result = new JSONObject(new String(api.exchange("/v1/attachments/" + metadata.getString("id") + "/content?offset=" + offset, "PUT", bytes, "application/octet-stream"), "UTF-8"));
        long next = result.getLong("offset"); if (next <= offset || next > file.length()) throw new Exception("INVALID_UPLOAD_OFFSET"); offset = next; input.seek(offset);
      }
    }
    api.object("/v1/attachments/" + metadata.getString("id") + "/complete", new JSONObject());
  }
}

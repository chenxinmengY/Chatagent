package local.chatagent.privatechat;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.app.Activity;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import java.util.Set;
import java.lang.ref.WeakReference;

final class MessageNotifications {
  private static final String CHAT="chatagent.chatId";
  private static WeakReference<Activity> visibleOwner=new WeakReference<>(null);
  private static String visibleChat;

  static synchronized void open(Context context,Activity owner,String chatId,Set<String> legacyMessageIds){
    open(context,owner,chatId,legacyMessageIds::contains);
  }
  static synchronized void open(Context context,Activity owner,String chatId,java.util.function.Predicate<String> legacyMessage){
    visibleOwner=new WeakReference<>(owner);visibleChat=chatId;
    LocalStore.get(context,chatId).markRead();
    NotificationManager manager=context.getSystemService(NotificationManager.class);
    for(StatusBarNotification item:manager.getActiveNotifications()){
      String tag=item.getTag(),scope=item.getNotification().extras.getString(CHAT);
      if(item.getId()!=2||tag==null||!tag.startsWith("message:"))continue;
      if(chatId.equals(scope)||scope==null&&legacyMessage.test(tag.substring(8)))manager.cancel(tag,item.getId());
    }
  }
  static synchronized void close(Object owner){if(visibleOwner.get()==owner){visibleOwner.clear();visibleChat=null;}}
  static int channelImportance(Context context){NotificationChannel channel=context.getSystemService(NotificationManager.class).getNotificationChannel("messages");return channel==null?-1:channel.getImportance();}
  static boolean enabled(Context context){return context.getSystemService(NotificationManager.class).areNotificationsEnabled()&&channelImportance(context)>NotificationManager.IMPORTANCE_NONE;}
  private static void record(Context context,String result){LocalStore runtime=LocalStore.get(context,"default");runtime.meta("lastNoticeResult",result);runtime.meta("lastNoticeAt",String.valueOf(System.currentTimeMillis()));}
  private static boolean allowed(Context context){
    if(!context.getSystemService(NotificationManager.class).areNotificationsEnabled()){record(context,"blocked_app");return false;}
    if(channelImportance(context)<=NotificationManager.IMPORTANCE_NONE){record(context,"blocked_channel");return false;}
    return true;
  }
  private static String notify(Context context,String tag,int id,Notification notice,String result){
    if(!allowed(context))return LocalStore.get(context,"default").readMeta("lastNoticeResult","");
    try{context.getSystemService(NotificationManager.class).notify(tag,id,notice);record(context,result);return result;}
    catch(SecurityException error){record(context,"blocked_permission");throw error;}
  }
  static synchronized String test(Context context,Notification notice){return notify(context,"notification-test",3,notice,"test_submitted");}
  static synchronized void post(Context context,String chatId,String messageId,Notification notification){
    Activity owner=visibleOwner.get();
    if(chatId.equals(visibleChat)&&owner!=null&&owner.hasWindowFocus()&&!owner.isFinishing()&&!owner.isDestroyed()){record(context,"visible_chat");return;}
    LocalStore.get(context,chatId).markUnread(messageId);
    notification.extras.putString(CHAT,chatId);
    notify(context,"message:"+messageId,2,notification,"message_submitted");
  }
}

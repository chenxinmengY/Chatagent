package local.chatagent.privatechat;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import java.util.Set;

final class MessageNotifications {
  private static final String CHAT="chatagent.chatId";
  private static Object visibleOwner;
  private static String visibleChat;

  static synchronized void open(Context context,Object owner,String chatId,Set<String> legacyMessageIds){
    visibleOwner=owner;visibleChat=chatId;
    LocalStore.get(context,chatId).markRead();
    NotificationManager manager=context.getSystemService(NotificationManager.class);
    for(StatusBarNotification item:manager.getActiveNotifications()){
      String tag=item.getTag(),scope=item.getNotification().extras.getString(CHAT);
      if(item.getId()!=2||tag==null||!tag.startsWith("message:"))continue;
      if(chatId.equals(scope)||scope==null&&legacyMessageIds.contains(tag.substring(8)))manager.cancel(tag,item.getId());
    }
  }
  static synchronized void close(Object owner){if(visibleOwner==owner){visibleOwner=null;visibleChat=null;}}
  static synchronized void post(Context context,String chatId,String messageId,Notification notification){
    if(chatId.equals(visibleChat))return;
    LocalStore.get(context,chatId).markUnread(messageId);
    notification.extras.putString(CHAT,chatId);
    context.getSystemService(NotificationManager.class).notify("message:"+messageId,2,notification);
  }
}

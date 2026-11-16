package local.chatagent.privatechat;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Process;
import android.service.notification.StatusBarNotification;
import org.json.*;

// Only lifecycle facts are stored here, never messages, server URLs or credentials.
final class BackgroundDiagnostics {
  static SharedPreferences prefs(Context context){return context.getSharedPreferences("background-diagnostics",0);}
  static synchronized void event(Context context,String name){
    try{
      JSONArray previous=new JSONArray(prefs(context).getString("events","[]")),events=new JSONArray();
      for(int i=Math.max(0,previous.length()-19);i<previous.length();i++)events.put(previous.get(i));
      events.put(new JSONObject().put("event",name).put("at",System.currentTimeMillis()).put("pid",Process.myPid()));
      prefs(context).edit().putString("events",events.toString()).commit();
    }catch(JSONException ignored){}
  }
  static JSONObject snapshot(Context context)throws JSONException{
    SharedPreferences prefs=prefs(context);
    JSONObject result=new JSONObject().put("manufacturer",Build.MANUFACTURER).put("androidRelease",Build.VERSION.RELEASE).put("pid",Process.myPid())
      .put("events",new JSONArray(prefs.getString("events","[]"))).put("testState",prefs.getString("testState","never_requested"))
      .put("testRequestedAt",prefs.getLong("testRequestedAt",0)).put("testDueAt",prefs.getLong("testDueAt",0)).put("testAttemptAt",prefs.getLong("testAttemptAt",0))
      .put("watchdogDueAt",prefs.getLong("watchdogDueAt",0));
    boolean connectionNotice=false;
    for(StatusBarNotification item:context.getSystemService(NotificationManager.class).getActiveNotifications())if(item.getId()==1&&item.getTag()==null)connectionNotice=true;
    result.put("connectionNoticePresent",connectionNotice);
    JSONArray exits=new JSONArray();
    if(Build.VERSION.SDK_INT>=30)try{
      for(ApplicationExitInfo exit:context.getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(context.getPackageName(),0,8)){
        exits.put(new JSONObject().put("at",exit.getTimestamp()).put("reason",exit.getReason()).put("reasonName",reason(exit.getReason())).put("status",exit.getStatus()).put("importance",exit.getImportance()).put("process",exit.getProcessName()));
      }
    }catch(RuntimeException error){result.put("exitHistoryError",error.getClass().getSimpleName());}
    return result.put("processExits",exits);
  }
  private static String reason(int value){
    switch(value){
      case ApplicationExitInfo.REASON_EXIT_SELF:return "exit_self";
      case ApplicationExitInfo.REASON_SIGNALED:return "signaled";
      case ApplicationExitInfo.REASON_LOW_MEMORY:return "low_memory";
      case ApplicationExitInfo.REASON_CRASH:return "crash";
      case ApplicationExitInfo.REASON_CRASH_NATIVE:return "crash_native";
      case ApplicationExitInfo.REASON_ANR:return "anr";
      case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:return "initialization_failure";
      case ApplicationExitInfo.REASON_PERMISSION_CHANGE:return "permission_change";
      case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:return "excessive_resource_usage";
      case ApplicationExitInfo.REASON_USER_REQUESTED:return "user_requested";
      case ApplicationExitInfo.REASON_USER_STOPPED:return "user_stopped";
      case ApplicationExitInfo.REASON_DEPENDENCY_DIED:return "dependency_died";
      case ApplicationExitInfo.REASON_OTHER:return "other";
      default:return "unknown_"+value;
    }
  }
}

package local.chatagent.privatechat;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;

// Prearm a fallback while healthy: abrupt process death may deliver no callbacks.
final class ConnectionRecovery {
  static final String ACTION="local.chatagent.privatechat.RECOVER_CONNECTION";
  static boolean enabled(Context context){return context.getSharedPreferences("runtime",0).getBoolean("enabled",false);}
  private static PendingIntent alarm(Context context,int key){return PendingIntent.getBroadcast(context,key,new Intent(context,BootReceiver.class).setAction(ACTION),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
  static synchronized void schedule(Context context){
    if(!enabled(context))return;
    context.getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,SystemClock.elapsedRealtime()+10000,alarm(context,1));
  }
  static synchronized void watch(Context context){
    if(!enabled(context))return;
    context.getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,SystemClock.elapsedRealtime()+120000,alarm(context,2));
    BackgroundDiagnostics.prefs(context).edit().putLong("watchdogDueAt",System.currentTimeMillis()+120000).apply();
  }
  static synchronized void cancel(Context context){AlarmManager manager=context.getSystemService(AlarmManager.class);manager.cancel(alarm(context,1));manager.cancel(alarm(context,2));BackgroundDiagnostics.prefs(context).edit().putLong("watchdogDueAt",0).apply();}
  static synchronized void pause(Context context){context.getSharedPreferences("runtime",0).edit().putBoolean("enabled",false).commit();cancel(context);NotificationProbe.cancel(context);BackgroundDiagnostics.event(context,"connection_paused");context.stopService(new Intent(context,SyncService.class));}
}

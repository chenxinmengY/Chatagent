package local.chatagent.privatechat;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

// The local notification control must not wait behind network I/O.
final class NotificationProbe {
  interface Poster { String post(); }
  private final Context context;
  private final Poster poster;
  private final Handler handler=new Handler(Looper.getMainLooper());
  private final Runnable fire=this::fire;
  NotificationProbe(Context context,Poster poster){this.context=context;this.poster=poster;}
  void request(long delay){
    long now=System.currentTimeMillis();
    BackgroundDiagnostics.prefs(context).edit().putBoolean("testPending",true).putLong("testRequestedAt",now).putLong("testDueAt",now+Math.max(0,delay)).putLong("testAttemptAt",0).putString("testState","scheduled").commit();
    BackgroundDiagnostics.event(context,"test_scheduled");restore();
  }
  void restore(){
    handler.removeCallbacks(fire);
    SharedPreferences prefs=BackgroundDiagnostics.prefs(context);
    if(prefs.getBoolean("testPending",false)&&ConnectionRecovery.enabled(context))handler.postDelayed(fire,Math.max(0,prefs.getLong("testDueAt",0)-System.currentTimeMillis()));
  }
  void close(){handler.removeCallbacks(fire);}
  static void cancel(Context context){
    SharedPreferences prefs=BackgroundDiagnostics.prefs(context);
    if(prefs.getBoolean("testPending",false))prefs.edit().putBoolean("testPending",false).putString("testState","cancelled").commit();
  }
  private void fire(){
    SharedPreferences prefs=BackgroundDiagnostics.prefs(context);
    if(!prefs.getBoolean("testPending",false))return;
    if(!ConnectionRecovery.enabled(context)){cancel(context);return;}
    long now=System.currentTimeMillis();
    if(now-prefs.getLong("testDueAt",0)>5*60000){prefs.edit().putBoolean("testPending",false).putString("testState","expired").commit();return;}
    prefs.edit().putBoolean("testPending",false).putString("testState","executing").putLong("testAttemptAt",now).commit();
    BackgroundDiagnostics.event(context,"test_executing");
    String result;
    try{result=poster.post();}catch(SecurityException error){result="blocked_permission";}catch(RuntimeException error){result="failed_"+error.getClass().getSimpleName();}
    prefs.edit().putString("testState",result).commit();BackgroundDiagnostics.event(context,"test_"+result);
  }
}

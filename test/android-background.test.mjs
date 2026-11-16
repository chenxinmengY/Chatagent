import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

test('实际 Android Java：划掉任务后的恢复、升级重连与主动暂停不冲突', t => {
  const { root } = sandbox(t), java = process.env.CHATAGENT_JDK ?? 'C:/Program Files/Java/jdk-17';
  const sources = {
    'android/content/SharedPreferences.java':`package android.content;public class SharedPreferences{private boolean enabled;public boolean getBoolean(String key,boolean fallback){return enabled;}public Editor edit(){return new Editor();}public class Editor{private boolean value;public Editor putLong(String key,long next){return this;}public Editor putBoolean(String key,boolean next){value=next;return this;}public void apply(){}public boolean commit(){enabled=value;return true;}}}`,
    'android/content/Context.java':`package android.content;import android.app.*;import java.util.*;public class Context{public final SharedPreferences prefs=new SharedPreferences();public final AlarmManager alarms=new AlarmManager();public final List<Intent> starts=new ArrayList<>();public int stopped;public boolean denied;public SharedPreferences getSharedPreferences(String name,int mode){return prefs;}public <T>T getSystemService(Class<T> type){return type.cast(alarms);}public void startForegroundService(Intent intent){if(denied)throw new IllegalStateException("background start restricted");starts.add(intent);}public boolean stopService(Intent intent){stopped++;return true;}}`,
    'android/content/Intent.java':`package android.content;public class Intent{public static final String ACTION_BOOT_COMPLETED="boot",ACTION_MY_PACKAGE_REPLACED="updated";private String action;public final Class<?> target;public Intent(Context c,Class<?> type){target=type;}public Intent setAction(String value){action=value;return this;}public String getAction(){return action;}}`,
    'android/content/BroadcastReceiver.java':`package android.content;public abstract class BroadcastReceiver{public abstract void onReceive(Context context,Intent intent);}`,
    'android/os/SystemClock.java':`package android.os;public class SystemClock{public static long elapsedRealtime(){return 100000;}}`,
    'android/app/PendingIntent.java':`package android.app;import android.content.*;public class PendingIntent{public static final int FLAG_UPDATE_CURRENT=1,FLAG_IMMUTABLE=2;public final Intent intent;public final int key,flags;private PendingIntent(Intent i,int k,int f){intent=i;key=k;flags=f;}public static PendingIntent getBroadcast(Context c,int key,Intent intent,int flags){return new PendingIntent(intent,key,flags);}}`,
    'android/app/AlarmManager.java':`package android.app;import java.util.*;public class AlarmManager{public static final int ELAPSED_REALTIME_WAKEUP=2;public final Map<Integer,PendingIntent> pending=new HashMap<>();public long at;public void setAndAllowWhileIdle(int type,long next,PendingIntent intent){if(type!=ELAPSED_REALTIME_WAKEUP)throw new AssertionError();at=next;pending.put(intent.key,intent);}public void cancel(PendingIntent intent){pending.remove(intent.key);}}`,
    'SyncService.java':`package local.chatagent.privatechat;public final class SyncService{}`,
    'BackgroundDiagnostics.java':`package local.chatagent.privatechat;import android.content.*;public final class BackgroundDiagnostics{static SharedPreferences prefs(Context c){return new SharedPreferences();}static void event(Context c,String name){}}`,
    'NotificationProbe.java':`package local.chatagent.privatechat;import android.content.*;public final class NotificationProbe{static void cancel(Context c){}}`,
    'LocalStore.java':`package local.chatagent.privatechat;import android.content.*;public class LocalStore{public static String status="";static LocalStore get(Context c){return new LocalStore();}void meta(String key,String value){status=value;}}`,
    'BackgroundCheck.java':`package local.chatagent.privatechat;import android.content.*;import android.app.*;public class BackgroundCheck{
      static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
      static Intent event(Context c,String action){return new Intent(c,BootReceiver.class).setAction(action);}
      public static void main(String[] args){
        Context c=new Context();BootReceiver receiver=new BootReceiver();
        ConnectionRecovery.schedule(c);receiver.onReceive(c,event(c,Intent.ACTION_BOOT_COMPLETED));check(c.alarms.pending.isEmpty()&&c.starts.isEmpty(),"Never enable a paused connection at boot");
        c.prefs.edit().putBoolean("enabled",true).commit();ConnectionRecovery.schedule(c);ConnectionRecovery.schedule(c);check(c.alarms.pending.size()==1&&c.alarms.at==110000,"Task removal schedules a single elapsed-time recovery without exact-alarm permission");
        PendingIntent alarm=c.alarms.pending.values().iterator().next();check(alarm.intent.target==BootReceiver.class&&(alarm.flags&PendingIntent.FLAG_IMMUTABLE)!=0,"Recovery stays internal and immutable");receiver.onReceive(c,alarm.intent);check(c.starts.size()==1&&c.starts.get(0).target==SyncService.class&&ConnectionRecovery.ACTION.equals(c.starts.get(0).getAction()),"Recovery starts the foreground messaging service");
        ConnectionRecovery.cancel(c);check(c.alarms.pending.isEmpty(),"A healthy service cancels recovery");
        ConnectionRecovery.watch(c);ConnectionRecovery.watch(c);check(c.alarms.pending.size()==1&&c.alarms.pending.containsKey(2)&&c.alarms.at==220000,"Prearm one recovery before a process can die without callbacks");ConnectionRecovery.schedule(c);check(c.alarms.pending.size()==2,"Cooperative fast recovery coexists with the prearmed watchdog");ConnectionRecovery.cancel(c);check(c.alarms.pending.isEmpty(),"Cancel both recovery paths");
        receiver.onReceive(c,event(c,Intent.ACTION_MY_PACKAGE_REPLACED));receiver.onReceive(c,event(c,Intent.ACTION_BOOT_COMPLETED));check(c.starts.size()==3,"Enabled connection recovers on upgrade and reboot");
        receiver.onReceive(c,event(c,"unrelated"));check(c.starts.size()==3,"Ignore unrelated broadcasts");
        ConnectionRecovery.schedule(c);ConnectionRecovery.pause(c);receiver.onReceive(c,alarm.intent);receiver.onReceive(c,event(c,Intent.ACTION_MY_PACKAGE_REPLACED));ConnectionRecovery.schedule(c);check(!ConnectionRecovery.enabled(c)&&c.stopped==1&&c.alarms.pending.isEmpty()&&c.starts.size()==3,"Pause cancels pending recovery; a late alarm or service destruction must not restart it");
        c.prefs.edit().putBoolean("enabled",true).commit();c.denied=true;receiver.onReceive(c,alarm.intent);check(LocalStore.status.contains("系统限制后台启动")&&c.starts.size()==3,"Android background restrictions are reported without a crash or retry loop");
        System.out.println("background recovery and explicit pause passed");
      }
    }`
  };
  for (const [name, body] of Object.entries(sources)) { const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body); }
  execFileSync(path.join(java,'bin/javac.exe'),['-encoding','UTF-8','-d',root,...Object.keys(sources).map(name=>path.join(root,name)),...['ConnectionRecovery','BootReceiver'].map(name=>path.resolve('apps/android/src/local/chatagent/privatechat/'+name+'.java'))]);
  assert.match(execFileSync(path.join(java,'bin/java.exe'),['-cp',root,'local.chatagent.privatechat.BackgroundCheck'],{encoding:'utf8'}),/background recovery and explicit pause passed/);
  const manifest=fs.readFileSync('apps/android/AndroidManifest.xml','utf8');
  assert.match(manifest,/<service\b[^>]*android:name="\.SyncService"[^>]*android:stopWithTask="false"[^>]*android:foregroundServiceType="remoteMessaging"/);
  assert.match(manifest,/android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
  assert.match(manifest,/android.intent.action.MY_PACKAGE_REPLACED/);
});

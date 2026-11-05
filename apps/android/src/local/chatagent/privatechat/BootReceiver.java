package local.chatagent.privatechat;
import android.content.*;
public final class BootReceiver extends BroadcastReceiver {
  public void onReceive(Context context, Intent intent) {
    if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && context.getSharedPreferences("runtime", 0).getBoolean("enabled", false)) {
      try { context.startForegroundService(new Intent(context, SyncService.class)); }
      catch (RuntimeException error) { LocalStore.get(context).meta("status", "系统限制后台启动，请打开应用恢复连接"); }
    }
  }
}

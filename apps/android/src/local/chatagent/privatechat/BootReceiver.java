package local.chatagent.privatechat;
import android.content.*;
public final class BootReceiver extends BroadcastReceiver {
  public void onReceive(Context context, Intent intent) {
    String action=intent.getAction();
    if ((Intent.ACTION_BOOT_COMPLETED.equals(action)||Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)||ConnectionRecovery.ACTION.equals(action)) && ConnectionRecovery.enabled(context)) {
      BackgroundDiagnostics.event(context,"recovery_requested");
      try { context.startForegroundService(new Intent(context, SyncService.class).setAction(ConnectionRecovery.ACTION));BackgroundDiagnostics.event(context,"recovery_start_requested"); }
      catch (RuntimeException error) { BackgroundDiagnostics.event(context,"recovery_restricted");LocalStore.get(context).meta("status", "系统限制后台启动，请打开应用恢复连接"); }
    }
  }
}

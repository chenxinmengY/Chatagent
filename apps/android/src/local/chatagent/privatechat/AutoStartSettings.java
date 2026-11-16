package local.chatagent.privatechat;

import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

// OEM activities are optional. Opening a page never grants or verifies permission.
final class AutoStartSettings {
  static boolean open(Context context){
    if("vivo".equalsIgnoreCase(Build.MANUFACTURER)||"iqoo".equalsIgnoreCase(Build.MANUFACTURER)){
      String[][] entries={
        {"com.vivo.permissionmanager","com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
        {"com.iqoo.secure","com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"}
      };
      for(String[] entry:entries)try{
        context.startActivity(new Intent().setComponent(new ComponentName(entry[0],entry[1])));return true;
      }catch(ActivityNotFoundException|SecurityException ignored){}
    }
    context.startActivity(new Intent(Settings.ACTION_SETTINGS));return false;
  }
}

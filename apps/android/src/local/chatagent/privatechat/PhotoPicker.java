package local.chatagent.privatechat;
import android.app.Activity;import android.content.*;import android.os.Build;import android.provider.MediaStore;
final class PhotoPicker {
 static boolean open(Activity activity,int request){
  boolean modern=Build.VERSION.SDK_INT>=33||(Build.VERSION.SDK_INT>=30&&android.os.ext.SdkExtensions.getExtensionVersion(30)>=2);
  if(modern)try{activity.startActivityForResult(new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*"),request);return true;}catch(ActivityNotFoundException|SecurityException ignored){}
  try{activity.startActivityForResult(new Intent(Intent.ACTION_PICK).setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,"image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),request);return true;}catch(ActivityNotFoundException|SecurityException ignored){return false;}
 }
}

package local.chatagent.privatechat;
import android.app.Activity;import android.content.*;import android.os.Build;import android.provider.MediaStore;
final class PhotoPicker {
 static boolean multiple(Activity activity,int request){
  return multiple(activity,request,20);
 }
 static boolean multiple(Activity activity,int request,int limit){
  if(limit<1||limit>20)return false;
  if(limit==1)return open(activity,request);
  boolean modern=Build.VERSION.SDK_INT>=33||(Build.VERSION.SDK_INT>=30&&android.os.ext.SdkExtensions.getExtensionVersion(30)>=2);
  if(modern)try{activity.startActivityForResult(new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*").putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX,limit),request);return true;}catch(ActivityNotFoundException|SecurityException|IllegalArgumentException ignored){}
  try{activity.startActivityForResult(new Intent(Intent.ACTION_PICK).setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,"image/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),request);return true;}catch(ActivityNotFoundException|SecurityException ignored){return false;}
 }
 static boolean open(Activity activity,int request){
  boolean modern=Build.VERSION.SDK_INT>=33||(Build.VERSION.SDK_INT>=30&&android.os.ext.SdkExtensions.getExtensionVersion(30)>=2);
  if(modern)try{activity.startActivityForResult(new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*"),request);return true;}catch(ActivityNotFoundException|SecurityException ignored){}
  try{activity.startActivityForResult(new Intent(Intent.ACTION_PICK).setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,"image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),request);return true;}catch(ActivityNotFoundException|SecurityException ignored){return false;}
 }
}

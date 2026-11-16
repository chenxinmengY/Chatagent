package local.chatagent.privatechat;
import android.os.Build;
import android.graphics.*;
import android.graphics.drawable.Drawable;
import java.io.File;

final class StickerImages {
  static Drawable decode(File file,int maxWidth,int maxHeight)throws Exception{
    if(Build.VERSION.SDK_INT>=28)return ImageDecoder.decodeDrawable(ImageDecoder.createSource(file),(decoder,info,source)->{int w=info.getSize().getWidth(),h=info.getSize().getHeight();float scale=Math.min(1f,Math.min((float)maxWidth/w,(float)maxHeight/h));decoder.setTargetSize(Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale)));});
    BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getPath(),options);options.inSampleSize=1;while(options.outWidth/options.inSampleSize>maxWidth*2||options.outHeight/options.inSampleSize>maxHeight*2)options.inSampleSize*=2;options.inJustDecodeBounds=false;Bitmap bitmap=BitmapFactory.decodeFile(file.getPath(),options);if(bitmap==null)throw new Exception("IMAGE_DECODE_FAILED");return new android.graphics.drawable.BitmapDrawable(null,bitmap);
  }
}

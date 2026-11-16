package local.chatagent.privatechat;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

final class AttachmentSelection {
 static List<Uri> read(Intent data,int remaining){
  LinkedHashSet<Uri> selected=new LinkedHashSet<>();
  if(data!=null){
   ClipData clip=data.getClipData();
   if(clip!=null)for(int i=0;i<clip.getItemCount();i++){Uri uri=clip.getItemAt(i).getUri();if(uri!=null)selected.add(uri);if(selected.size()>remaining)throw new IllegalArgumentException("FILE_LIMIT");}
   else if(data.getData()!=null)selected.add(data.getData());
  }
  if(selected.size()>remaining)throw new IllegalArgumentException("FILE_LIMIT");
  return new ArrayList<>(selected);
 }
}

package local.chatagent.privatechat;
import java.io.File;
import java.util.*;
import org.json.*;

final class MediaCache {
  static void hashes(JSONArray files,Set<String> target){if(files!=null)for(int i=0;i<files.length();i++){String h=files.optJSONObject(i).optString("sha256");if(h.matches("[a-f0-9]{64}"))target.add(h);}}
  static long[] inspect(File folder,LocalStore store,boolean clear)throws Exception {
    Set<String> keep=new HashSet<>(),available=new HashSet<>();
    for(LocalStore chat:store.siblings()){
      hashes(new JSONArray(chat.readMeta("draftFiles","[]")),keep);
      for(JSONObject row:chat.pending())hashes(row.optJSONArray("files"),keep);
      for(JSONObject row:chat.rows("messages","seq"))hashes(row.optJSONArray("attachments"),row.optString("state").equals("completed")?available:keep);
    }
    long total=0,recoverable=0,removed=0;File[] files=folder.listFiles();if(files!=null)for(File f:files){total+=f.length();if(f.isFile()&&f.getName().matches("[a-f0-9]{64}")&&available.contains(f.getName())&&!keep.contains(f.getName())){recoverable+=f.length();if(clear&&f.delete())removed+=f.length();}}
    return new long[]{total,recoverable,removed};
  }
}

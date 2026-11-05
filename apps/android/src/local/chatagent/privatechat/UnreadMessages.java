package local.chatagent.privatechat;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

// Stable message IDs are persisted in LocalStore metadata, independently of notifications.
public final class UnreadMessages {
  public static String add(String state,String id){
    String encoded=Base64.getUrlEncoder().withoutPadding().encodeToString(id.getBytes(StandardCharsets.UTF_8));
    for(String value:state.split("\n"))if(value.equals(encoded))return state;
    return state.isEmpty()?encoded:state+"\n"+encoded;
  }
  public static int count(String state){return state.isEmpty()?0:state.split("\n").length;}
}

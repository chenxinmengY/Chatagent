package local.chatagent.privatechat;

public final class MessagePresentation {
  public static String preview(String text,String device,String clientId,String mediaType){
    if(!text.trim().isEmpty()&&!voiceCaption(device,clientId,text)){String value=text.trim().replaceAll("\\s+"," ");return value.length()>2000?value.substring(0,2000)+"…":value;}
    if(mediaType.startsWith("audio/"))return "[语音]";
    if(mediaType.startsWith("image/"))return "[图片]";
    if(!mediaType.isEmpty())return "[文件]";
    return "[消息]";
  }
  public static boolean hidden(String device,String clientId){return "plugin-delivery".equals(device)&&(clientId.startsWith("asr-start-")||clientId.startsWith("asr-text-"));}
  public static boolean voiceCaption(String device,String clientId){return "plugin-delivery".equals(device)&&clientId.matches("voice-[a-f0-9]{40}-[0-9]+");}
  public static boolean voiceCaption(String device,String clientId,String text){return voiceCaption(device,clientId)||"plugin-delivery".equals(device)&&clientId.matches("[a-f0-9]{64}")&&("整首翻唱（电脑已保存）".equals(text)||"翻唱片段（电脑已保存）".equals(text));}
}

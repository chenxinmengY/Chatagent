package local.chatagent.privatechat;

import android.media.MediaPlayer;
import java.io.*;
import java.util.HashMap;

// One inline player shared by all voice bars. Leaving the chat releases it.
final class AudioPlayer {
  private static MediaPlayer player;
  private static String current="",state="idle";
  private static int pendingStart;
  private static boolean resumeAfterScrub;
  private static final HashMap<String,Integer> durations=new HashMap<>();
  static String state(String id){return id.equals(current)?state:"idle";}
  static int seconds(String id){Integer ms=durations.get(id);return ms==null?0:Math.max(1,(ms+999)/1000);}
  static int position(String id){try{return id.equals(current)&&player!=null&&!state.equals("loading")?player.getCurrentPosition():0;}catch(Exception e){return 0;}}
  static int duration(String id){Integer ms=durations.get(id);return ms==null?0:ms;}
  static void rememberDuration(String id,int ms){if(ms>0)durations.put(id,ms);}
  static void close(){if(player!=null){player.release();player=null;}current="";state="idle";pendingStart=0;resumeAfterScrub=false;}
  static boolean stopIfActive(String id){if(id.equals(current)&&(state.equals("playing")||state.equals("loading")||state.equals("seeking"))){close();return true;}return false;}
  static void loading(String id){if(!id.equals(current)){close();current=id;state="loading";}}
  static void failed(String id){if(id.equals(current)){if(player!=null){player.release();player=null;}state="error";}}
  static void beginScrub(String id){if(id.equals(current)&&player!=null&&state.equals("playing")){player.pause();state="paused";resumeAfterScrub=true;}}
  static void cancelScrub(String id){if(id.equals(current)&&player!=null&&resumeAfterScrub&&state.equals("paused")){player.start();state="playing";}resumeAfterScrub=false;}
  static boolean playCurrent(String id,int position){
    if(!id.equals(current)||player==null)return false;
    resumeAfterScrub=false;pendingStart=Math.max(0,position);if(state.equals("loading"))return true;
    player.pause();state="seeking";player.seekTo(Math.min(pendingStart,Math.max(0,player.getDuration()-1)));return true;
  }
  static void play(File file,String id,int position){
    if(playCurrent(id,position))return;
    close();current=id;state="loading";pendingStart=Math.max(0,position);final MediaPlayer owned=new MediaPlayer();player=owned;
    owned.setOnSeekCompleteListener(p->{if(player==owned&&state.equals("seeking")){p.start();state="playing";}});
    owned.setOnPreparedListener(p->{if(player!=owned)return;durations.put(id,p.getDuration());if(pendingStart>0){state="seeking";p.seekTo(Math.min(pendingStart,Math.max(0,p.getDuration()-1)));}else{p.start();state="playing";}});
    owned.setOnCompletionListener(p->{if(player==owned)state="ended";});
    owned.setOnErrorListener((p,a,b)->{if(player==owned)failed(id);return true;});
    try(FileInputStream input=new FileInputStream(file)){owned.setDataSource(input.getFD());owned.prepareAsync();}catch(Exception e){failed(id);}
  }
}

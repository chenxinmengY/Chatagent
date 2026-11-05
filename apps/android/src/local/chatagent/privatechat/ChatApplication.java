package local.chatagent.privatechat;
import android.app.Application;
import java.io.*;
import org.json.*;
public final class ChatApplication extends Application {
  public void onCreate(){super.onCreate();Thread.UncaughtExceptionHandler previous=Thread.getDefaultUncaughtExceptionHandler();Thread.setDefaultUncaughtExceptionHandler((thread,error)->{
    try{JSONArray frames=new JSONArray();for(StackTraceElement frame:error.getStackTrace()){if(frames.length()>=20)break;frames.put(frame.getClassName()+"."+frame.getMethodName()+":"+frame.getLineNumber());}JSONObject report=new JSONObject().put("exceptionClass",error.getClass().getName()).put("frames",frames).put("at",System.currentTimeMillis());try(FileOutputStream output=openFileOutput("last-crash.json",MODE_PRIVATE)){output.write(report.toString().getBytes("UTF-8"));output.getFD().sync();}}catch(Exception ignored){}
    if(previous!=null)previous.uncaughtException(thread,error);
  });}
}

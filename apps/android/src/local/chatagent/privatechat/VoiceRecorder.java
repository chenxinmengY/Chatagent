package local.chatagent.privatechat;

import android.media.*;
import java.io.*;
import java.util.concurrent.*;

// Foreground-only PCM capture. Completed files survive in the draft; an
// interrupted, unfinished capture is discarded and is never sent implicitly.
final class VoiceRecorder {
  private AudioRecord input;
  private Future<?> writer;
  private final ExecutorService worker=Executors.newSingleThreadExecutor();
  private volatile boolean capturing;
  private volatile Exception failure;
  private File file;
  private long bytes;
  void start(File target) throws Exception {
    if(input!=null)throw new IOException("RECORDING_BUSY");
    int buffer=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
    if(buffer<=0)throw new IOException("MIC_UNAVAILABLE");
    input=new AudioRecord(MediaRecorder.AudioSource.MIC,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,Math.max(buffer,8192));
    file=target;bytes=0;failure=null;
    try {
      if(input.getState()!=AudioRecord.STATE_INITIALIZED)throw new IOException("MIC_UNAVAILABLE");
      input.startRecording();
      if(input.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IOException("MIC_UNAVAILABLE");
      capturing=true;
      writer=worker.submit(()->{
        try(RandomAccessFile output=new RandomAccessFile(file,"rw")){
          output.setLength(0);output.write(new byte[44]);byte[] data=new byte[8192];
          while(capturing && bytes<16000L*2*120){int n=input.read(data,0,data.length);if(n<0){if(capturing)throw new IOException("MIC_READ_FAILED");break;}if(n>0){output.write(data,0,n);bytes+=n;}}
          output.seek(0);output.writeBytes("RIFF");le32(output,36+bytes);output.writeBytes("WAVEfmt ");le32(output,16);le16(output,1);le16(output,1);le32(output,16000);le32(output,32000);le16(output,2);le16(output,16);output.writeBytes("data");le32(output,bytes);output.getFD().sync();
        }catch(Exception error){failure=error;}finally{capturing=false;}
      });
    }catch(Exception error){input.release();input=null;throw error;}
  }
  boolean finished(){return writer!=null&&writer.isDone();}
  File stop(boolean keep) throws Exception {
    capturing=false;Exception error=null;
    if(input!=null)try{input.stop();}catch(Exception e){error=e;}
    try{if(writer!=null)writer.get(5,TimeUnit.SECONDS);}catch(Exception e){error=e;}
    if(input!=null){input.release();input=null;}writer=null;
    if(failure!=null)error=failure;
    if(!keep||error!=null||bytes<16000){if(file!=null)file.delete();if(keep)throw new IOException(error==null?"RECORDING_TOO_SHORT":"RECORDING_FAILED");return null;}
    File completed=file;file=null;return completed;
  }
  void close(){try{stop(false);}catch(Exception ignored){}worker.shutdown();}
  private static void le32(RandomAccessFile f,long n)throws IOException{for(int i=0;i<4;i++)f.write((int)(n>>(8*i))&255);}
  private static void le16(RandomAccessFile f,int n)throws IOException{f.write(n&255);f.write((n>>8)&255);}
}

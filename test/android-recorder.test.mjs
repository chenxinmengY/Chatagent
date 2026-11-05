import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

test('实际Java录音器：PCM头、结束保留、取消、短录音和麦克风失败', t => {
  const { root } = sandbox(t), media = path.join(root, 'android/media'); fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, 'AudioFormat.java'), 'package android.media;public class AudioFormat{public static final int CHANNEL_IN_MONO=1,ENCODING_PCM_16BIT=2;}');
  fs.writeFileSync(path.join(media, 'MediaRecorder.java'), 'package android.media;public class MediaRecorder{public static class AudioSource{public static final int MIC=1;}}');
  fs.writeFileSync(path.join(media, 'AudioRecord.java'), `package android.media;public class AudioRecord{
 public static final int STATE_INITIALIZED=1,RECORDSTATE_RECORDING=3;public static int mode=0,released=0;boolean active=false;int frames=0;
 public static int getMinBufferSize(int a,int b,int c){return 1024;}public AudioRecord(int a,int b,int c,int d,int e){}
 public int getState(){return mode==1?0:1;}public int getRecordingState(){return active?3:1;}public void startRecording(){active=true;}
 public int read(byte[] b,int o,int n){try{Thread.sleep(1);}catch(Exception e){}if(!active)return -1;if(mode==2)return -1;if(mode==3)return 0;frames++;for(int i=0;i<n;i++)b[i]=(byte)i;return n;}
 public void stop(){active=false;}public void release(){released++;}
}`);
  fs.writeFileSync(path.join(root, 'RecorderCheck.java'), `package local.chatagent.privatechat;import android.media.AudioRecord;import java.io.*;import java.nio.*;
public class RecorderCheck{
 static void check(boolean value)throws Exception{if(!value)throw new Exception("ASSERTION_FAILED");}
 static void recorded(File file,long bytes)throws Exception{long end=System.nanoTime()+5000000000L;while(file.length()<bytes&&System.nanoTime()<end)Thread.sleep(2);check(file.length()>=bytes);}
 public static void main(String[] args)throws Exception{
 File folder=new File(args[0]);
 AudioRecord.mode=0;VoiceRecorder a=new VoiceRecorder();File first=new File(folder,"keep.wav");File saved;try{a.start(first);recorded(first,16428);saved=a.stop(true);}finally{a.close();}check(saved.exists());byte[] header=new byte[44];try(FileInputStream in=new FileInputStream(saved)){in.read(header);}ByteBuffer b=ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);check(new String(header,0,4,"US-ASCII").equals("RIFF"));check(b.getInt(24)==16000);check(b.getInt(40)==saved.length()-44);
 VoiceRecorder c=new VoiceRecorder();File cancelled=new File(folder,"cancel.wav");try{c.start(cancelled);recorded(cancelled,44);check(c.stop(false)==null);}finally{c.close();}check(!cancelled.exists());
 AudioRecord.mode=3;VoiceRecorder shortOne=new VoiceRecorder();File shortFile=new File(folder,"short.wav");shortOne.start(shortFile);try{shortOne.stop(true);throw new Exception("short accepted");}catch(IOException e){check(e.getMessage().equals("RECORDING_TOO_SHORT"));}shortOne.close();check(!shortFile.exists());
 AudioRecord.mode=1;VoiceRecorder unavailable=new VoiceRecorder();try{unavailable.start(new File(folder,"bad.wav"));throw new Exception("bad accepted");}catch(IOException e){check(e.getMessage().equals("MIC_UNAVAILABLE"));}unavailable.close();
 AudioRecord.mode=2;VoiceRecorder readError=new VoiceRecorder();File corrupt=new File(folder,"error.wav");readError.start(corrupt);long end=System.nanoTime()+5000000000L;while(!readError.finished()&&System.nanoTime()<end)Thread.sleep(2);try{readError.stop(true);throw new Exception("read error accepted");}catch(IOException e){check(e.getMessage().equals("RECORDING_FAILED"));}readError.close();check(!corrupt.exists());check(AudioRecord.released==5);System.out.println("5 recorder cases passed");
 }}
`);
  const java = process.env.CHATAGENT_JDK ?? 'C:/Program Files/Java/jdk-17';
  execFileSync(path.join(java, 'bin/javac.exe'), ['-encoding','UTF-8','-d',root, ...['AudioFormat.java','MediaRecorder.java','AudioRecord.java'].map(f => path.join(media,f)), path.resolve('apps/android/src/local/chatagent/privatechat/VoiceRecorder.java'), path.join(root,'RecorderCheck.java')]);
  assert.match(execFileSync(path.join(java, 'bin/java.exe'), ['-cp',root,'local.chatagent.privatechat.RecorderCheck',root], { encoding:'utf8', timeout:15000 }), /5 recorder cases passed/);
});

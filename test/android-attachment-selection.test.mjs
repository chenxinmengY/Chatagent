import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sandbox} from './helpers.mjs';

test('Android gallery results accept single and multiple URIs, deduplicate and reject an oversized selection before import',t=>{
 const {root}=sandbox(t),sources={
  'android/net/Uri.java':'package android.net;public class Uri{public final String value;public Uri(String v){value=v;}public boolean equals(Object other){return other instanceof Uri&&value.equals(((Uri)other).value);}public int hashCode(){return value.hashCode();}}',
  'android/content/ClipData.java':'package android.content;import android.net.Uri;public class ClipData{private final Uri[] values;public ClipData(Uri...v){values=v;}public int getItemCount(){return values.length;}public Item getItemAt(int i){return new Item(values[i]);}public static class Item{private final Uri value;Item(Uri v){value=v;}public Uri getUri(){return value;}}}',
  'android/content/Intent.java':'package android.content;import android.net.Uri;public class Intent{public Uri data;public ClipData clip;public Uri getData(){return data;}public ClipData getClipData(){return clip;}}',
  'Check.java':`package local.chatagent.privatechat;import android.content.*;import android.net.Uri;import java.util.*;public class Check{
   static void check(boolean ok){if(!ok)throw new AssertionError();}
   public static void main(String[] args){
    check(AttachmentSelection.read(null,8).isEmpty());Intent data=new Intent();check(AttachmentSelection.read(data,8).isEmpty());
    Uri first=new Uri("content:first"),second=new Uri("content:second");data.data=first;check(AttachmentSelection.read(data,8).equals(Arrays.asList(first)));
    data.clip=new ClipData(first,null,new Uri("content:first"),second);check(AttachmentSelection.read(data,2).equals(Arrays.asList(first,second)));
    try{AttachmentSelection.read(data,1);throw new AssertionError();}catch(IllegalArgumentException expected){check(expected.getMessage().equals("FILE_LIMIT"));}
    data.clip=null;try{AttachmentSelection.read(data,0);throw new AssertionError();}catch(IllegalArgumentException expected){}
    check(data.getData()==first);System.out.println("gallery results passed");
   }}`
 };
 for(const [name,body]of Object.entries(sources)){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
 const java=process.env.CHATAGENT_JDK??'C:/Program Files/Java/jdk-17';
 execFileSync(path.join(java,'bin/javac.exe'),['-encoding','UTF-8','-d',root,...Object.keys(sources).map(n=>path.join(root,n)),path.resolve('apps/android/src/local/chatagent/privatechat/AttachmentSelection.java')]);
 assert.match(execFileSync(path.join(java,'bin/java.exe'),['-cp',root,'local.chatagent.privatechat.Check'],{encoding:'utf8'}),/gallery results passed/);
});

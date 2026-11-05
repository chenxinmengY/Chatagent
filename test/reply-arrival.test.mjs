import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {BubbleArrival} from '../apps/web/bubble-arrival.js';import {sandbox} from './helpers.mjs';
test('incoming bubbles are staggered once; history, own messages and resumed chats stay immediate',()=>{
 const a=new BubbleArrival(),at=100000;a.prime(['history']);assert.equal(a.state('history',true,at,at),0);
 assert.equal(a.state('a',true,at,at),1);assert.equal(a.state('b',true,at,at),-1);assert.equal(a.state('c',true,at,at),-1);
 assert.equal(a.state('own',false,at,at),0);assert.equal(a.state('backfill',true,at-40000,at),0);assert.equal(a.state('a',true,at,at+200),0);
 assert.equal(a.ready(at+849),false);assert.equal(a.ready(at+850),true);assert.equal(a.state('b',true,at,at+850),1);assert.equal(a.state('b',true,at,at+851),0);assert.equal(a.state('c',true,at,at+1699),-1);assert.equal(a.state('c',true,at,at+1700),1);
 a.reset();a.prime(['a','b','c']);assert.equal(a.state('c',true,at,at+2000),0);
});
test('actual Android arrival scheduler preserves order without delaying outgoing bubbles',t=>{
 const {root}=sandbox(t),java=process.env.CHATAGENT_JDK??'C:/Program Files/Java/jdk-17',file=path.join(root,'ArrivalCheck.java');fs.writeFileSync(file,`package local.chatagent.privatechat;import java.util.*;public class ArrivalCheck{static void check(boolean b){if(!b)throw new AssertionError();}public static void main(String[] args){BubbleArrival a=new BubbleArrival();long n=100000;a.prime(Arrays.asList("history"));check(a.state("history",true,n,n)==0);check(a.state("one",true,n,n)==1);check(a.state("two",true,n,n)==-1);check(a.state("three",true,n,n)==-1);check(a.state("own",false,n,n)==0);check(a.state("old",true,n-40000,n)==0);check(!a.ready(n+849));check(a.ready(n+850));check(a.state("two",true,n,n+850)==1);check(a.state("two",true,n,n+851)==0);check(a.state("three",true,n,n+1699)==-1);check(a.state("three",true,n,n+1700)==1);a.reset();a.prime(Arrays.asList("one","two","three"));check(a.state("three",true,n,n+2000)==0);System.out.println("passed");}}`);
 execFileSync(path.join(java,'bin/javac.exe'),['-encoding','UTF-8','-d',root,file,path.resolve('apps/android/src/local/chatagent/privatechat/BubbleArrival.java')]);assert.match(execFileSync(path.join(java,'bin/java.exe'),['-cp',root,'local.chatagent.privatechat.ArrivalCheck'],{encoding:'utf8'}),/passed/);
});

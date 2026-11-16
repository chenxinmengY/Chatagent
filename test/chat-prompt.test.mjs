import test from 'node:test';
import assert from 'node:assert/strict';
import {replyLayoutNotice} from '../packages/conversation/reply-layout.mjs';
import {CHAT_PROMPT_SECTION,chatPrompt,isolateChatPrompt} from '../packages/dsh-bridge/chat-prompt.mjs';
import {splitReply} from '../packages/conversation/preferences.mjs';

test('chat layout matches delivery limits without cutting sentences, code or continuous instructions',()=>{
 assert.match(replyLayoutNotice(0),/不设固定条数上限/);
 assert.match(replyLayoutNotice(1),/只发送一条/);
 assert.match(replyLayoutNotice(3),/最多 3 条/);
 for(const value of [-1,21,1.1,'2',null])assert.throws(()=>replyLayoutNotice(value),/INVALID_REPLY_LIMIT/);
 const reply='嗯，主人，我在呢\n\n刚刚看到一个想和您聊的小问题\n\n您平时会把喜欢的歌设成闹钟吗？';
 assert.deepEqual(splitReply(reply,0),reply.split('\n\n'));
 assert.deepEqual(splitReply(reply,1),[reply]);
 assert.deepEqual(splitReply(reply,2),[reply.split('\n\n')[0],reply.split('\n\n').slice(1).join('\n\n')]);
 assert.deepEqual(splitReply('我在呢，主人，您想聊什么？',0),['我在呢，主人，您想聊什么？']);
 for(const reply of ['完整说明\n\n```js\nx = 1.5\n```','完整步骤\n\n1. 第一步\n2. 第二步','引用\n\n> 你好'])assert.deepEqual(splitReply(reply,0),[reply]);
});

test('scoped chat prompt isolates personas while retaining tools, memories and current media evidence',()=>{
 const persona='SYNTHETIC_PERSONA 原文 {{字面量}} 不用句号';
 const text=chatPrompt(persona,0);assert.ok(text.includes(persona));assert.match(text,/空行分隔不同消息/);
 const assembly={sections:[{name:'dsh-purge-identity',text:'OTHER_IDENTITY'},{name:'deployment:persona-suffix',text:'CODING_PERSONA'},{name:CHAT_PROMPT_SECTION,text},{name:'memory-hint',text:'OTHER_USER_NAME'}],contexts:[{name:'memory',text:'MEMORY_EVIDENCE'},{name:'chatagent:audio-input',text:'VOICE_TRANSCRIPT'},{name:'chatagent:music',text:'MUSIC_EVIDENCE'}],tools:[{name:'remember'},{name:'chatagent_send_voice'}],variables:{}};
 const isolated=isolateChatPrompt(assembly);
 assert.deepEqual(isolated.sections.map(s=>s.name),[CHAT_PROMPT_SECTION,'memory-hint']);
 assert.equal(isolated.sections[0].text,text);assert.doesNotMatch(JSON.stringify(isolated.sections),/OTHER_IDENTITY|CODING_PERSONA|OTHER_USER_NAME/);
 assert.deepEqual(isolated.contexts,assembly.contexts);assert.deepEqual(isolated.tools,assembly.tools);
 assert.equal(assembly.sections[3].text,'OTHER_USER_NAME','Do not mutate another agent’s registry');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {assertPublicSource,auditPublicTree} from '../scripts/source-policy.mjs';
import {sandbox} from './helpers.mjs';

test('public source audit rejects private paths, credentials, owner literals and unreviewed binaries',()=>{
 for(const name of ['data/chat.sqlite','shared-files/photo.png','workspace.private.json','cert.pem','.env','../escape.txt','verification/report.json'])assert.throws(()=>assertPublicSource(name,Buffer.from('safe')),/SOURCE_PRIVATE_FILE/);
 for(const secret of ['sk-'+'x'.repeat(32),'ghp_'+'y'.repeat(32),'private owner'])assert.throws(()=>assertPublicSource('README.md',Buffer.from(secret),{privateLiterals:['private owner']}),/SOURCE_PRIVATE_CONTENT/);
 assert.throws(()=>assertPublicSource('image.png',Buffer.from([1,0,2])),/SOURCE_PRIVATE_CONTENT/);
 assert.throws(()=>assertPublicSource('unexpected.wasm',Buffer.from('code')),/SOURCE_UNREVIEWED_BINARY/);
 assert.doesNotThrow(()=>assertPublicSource('THIRD_PARTY_NOTICES.md',Buffer.from('Upstream authors retain their licenses.')));
});

test('public source inventory hashes the actual payload and detects newly added private content',t=>{
 const {root}=sandbox(t);fs.writeFileSync(path.join(root,'README.md'),'public source');
 assert.equal(auditPublicTree(root).find(file=>file.path==='README.md').bytes,13);
 fs.writeFileSync(path.join(root,'token.txt'),'private owner');assert.throws(()=>auditPublicTree(root,{privateLiterals:['private owner']}),/SOURCE_PRIVATE_CONTENT/);
});

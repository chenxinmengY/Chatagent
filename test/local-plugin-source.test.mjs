import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sandbox} from './helpers.mjs';
import {scanPlugins} from '../packages/local-user-plugins/packages/plugin-api/catalog.mjs';

test('new plugin workspace has fresh local scope, empty timetable and disabled schedules; refuses overwrite',t=>{
  const {root}=sandbox(t),target=path.join(root,'plugins'),session='chatagent-00000000-0000-0000-0000-000000000001';
  execFileSync(process.execPath,['scripts/prepare-local-plugins.mjs',target,session],{windowsHide:true});
  const read=f=>JSON.parse(fs.readFileSync(path.join(target,f),'utf8'));
  const binding=read('chatagent-binding.json');
  assert.equal(binding.sessionId,session);assert.match(binding.account,/^[a-f0-9]{64}$/);assert.equal(binding.remindersEnabled,false);
  assert.deepEqual(read('config/plugins.json').plugins,{});
  assert.equal(read('config/media-settings.json').music.enabled,false);assert.equal(read('config/media-settings.json').video.enabled,false);
  assert.deepEqual(read('plugins/course-query/assets/timetable.json').courses,[]);
  const plugins=scanPlugins(target);assert.deepEqual(plugins.map(p=>p.id).sort(),['course-query','daily-reminders']);assert.ok(plugins.every(p=>!p.invalid&&p.revision));
  const before=fs.readFileSync(path.join(target,'chatagent-binding.json'),'utf8');
  assert.throws(()=>execFileSync(process.execPath,['scripts/prepare-local-plugins.mjs',target,session],{windowsHide:true,stdio:'pipe'}));
  assert.equal(fs.readFileSync(path.join(target,'chatagent-binding.json'),'utf8'),before);
});

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { assertPlain } from '../migration/standby-capture.mjs';

// Request text travels over stdin, never through PowerShell source or arguments.
// Always write a file: synthesis must never play on the computer's speakers.
const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($request.action -eq 'voices') {
    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | ForEach-Object { @{ name=$_.VoiceInfo.Name; culture=$_.VoiceInfo.Culture.Name } })
    ConvertTo-Json -InputObject $voices -Compress
  } else {
    $synth.SelectVoice($request.voice)
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($request.file, $format)
    $synth.Speak($request.text)
    $synth.SetOutputToNull()
    Write-Output '{"completed":true}'
  }
} finally { $synth.Dispose() }
`;

export function runSystemVoice(request, { signal, platform = process.platform } = {}) {
  if (platform !== 'win32') throw Error('VOICE_REPLY_WINDOWS_REQUIRED');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000, maxBuffer: 65536, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) return reject(Error(signal?.aborted ? 'VOICE_REPLY_CANCELLED' : 'VOICE_REPLY_SYSTEM_FAILED'));
      try { resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))); } catch { reject(Error('VOICE_REPLY_SYSTEM_FAILED')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
  });
}

export function inspectVoiceWav(file) {
  assertPlain(file);
  const bytes = fs.readFileSync(file);
  if (bytes.length < 44 || bytes.length > 16 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw Error('VOICE_REPLY_AUDIO_INVALID');
  let format, data, offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw Error('VOICE_REPLY_AUDIO_INVALID');
    const type = bytes.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') { if(format || ![16,18].includes(size)) throw Error('VOICE_REPLY_AUDIO_INVALID'); format = { codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bytesPerSecond: bytes.readUInt32LE(start + 8), align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) }; }
    if (type === 'data') { if (data) throw Error('VOICE_REPLY_AUDIO_INVALID'); data = bytes.subarray(start, start + size); }
    offset = start + size + size % 2;
  }
  if (offset !== bytes.length || !format || !data?.length || format.codec !== 1 || format.channels !== 1 || format.rate !== 24000 || format.bits !== 16 || format.align !== 2 || format.bytesPerSecond !== 48000 || data.length % 2 || data.length / 48000 > 220) throw Error('VOICE_REPLY_AUDIO_INVALID');
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), seconds: data.length / 48000, provenance: 'windows-installed-chinese-voice' };
}

export class VoiceReplies {
  constructor({ root, legacy = null, mansui = null, run = runSystemVoice, platform = process.platform }) {
    if (!path.isAbsolute(root)) throw Error('VOICE_REPLY_ROOT_INVALID');
    assertPlain(root);
    this.root = path.join(root, 'voice-replies'); this.file = path.join(this.root, 'settings.json');
    this.legacy = legacy; this.mansui = mansui; this.run = run; this.platform = platform; this.busy = false; this.closed = false; this.controllers = new Set();
  }
  settings() {
    assertPlain(this.root); assertPlain(this.file);
    if (!fs.existsSync(this.file)) return { source: this.mansui ? 'mansui' : this.legacy ? 'existing' : 'none', voice: null };
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (value.format !== 'chatagent-voice-replies-v1' || !['system', 'existing','mansui'].includes(value.source) || value.source==='mansui'&&!this.mansui || value.source === 'system' && (typeof value.voice !== 'string' || !value.voice || value.voice.length > 200) || value.source === 'existing' && !this.legacy) throw Error('VOICE_REPLY_SETTINGS_INVALID');
    if(value.transcription&&(!['existing','managed'].includes(value.transcription.source)||!/^[a-f0-9]{64}$/.test(value.transcription.manifestHash??'')))throw Error('VOICE_REPLY_SETTINGS_INVALID');
    return this.mansui?{...value,source:'mansui',voice:null}:value;
  }
  read() {
    const value = this.settings();
    return { source: value.source, voice: value.voice, hasExisting: !!this.legacy&&!this.mansui, ...(this.mansui?{hasMansui:true}:{}), systemSupported: !this.mansui&&this.platform === 'win32', busy: this.busy };
  }
  async exclusive(action) {
    if (this.closed) throw Error('VOICE_REPLY_CLOSED');
    if (this.busy) throw Error('VOICE_REPLY_BUSY');
    this.busy = true;
    const controller = new AbortController(); this.controllers.add(controller);
    try { return await action(controller.signal); } finally { this.controllers.delete(controller); this.busy = false; }
  }
  async systemAudio({ text, directory, id, signal, voice }) {
    if (!path.isAbsolute(directory) || !/^[\w-]{1,100}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 220) throw Error('VOICE_REPLY_REQUEST_INVALID');
    assertPlain(directory); if (!fs.statSync(directory).isDirectory()) throw Error('VOICE_REPLY_REQUEST_INVALID');
    const file = path.join(directory, id + '.wav'); assertPlain(file);
    if (fs.existsSync(file)) throw Error('VOICE_REPLY_OUTPUT_EXISTS');
    // Reserve this output before invoking the native engine.
    fs.closeSync(fs.openSync(file, 'wx'));
    try {
      const result = await this.run({ action: 'synthesize', text, voice, file }, { signal, platform: this.platform });
      signal?.throwIfAborted();
      if (result?.completed !== true) throw Error('VOICE_REPLY_SYSTEM_FAILED');
      return inspectVoiceWav(file);
    } catch (error) { if (fs.existsSync(file)) { assertPlain(file); fs.unlinkSync(file); } throw error; }
  }
  async setup({ source, prepareTranscription } = {}) {
    if (this.mansui&&source!=='mansui' || !['system', 'existing','mansui'].includes(source)) throw Error('VOICE_REPLY_REQUEST_INVALID');
    return this.exclusive(async signal => {
      let voice = null,transcription=this.settings().transcription;
      if(source==='mansui'){if(!this.mansui)throw Error('VOICE_REPLY_EXISTING_UNAVAILABLE');}
      else if (source === 'existing') { if (!this.legacy) throw Error('VOICE_REPLY_EXISTING_UNAVAILABLE'); }
      else {
        if (this.platform !== 'win32') throw Error('VOICE_REPLY_WINDOWS_REQUIRED');
        const voices = await this.run({ action: 'voices' }, { signal, platform: this.platform });
        if (!Array.isArray(voices)) throw Error('VOICE_REPLY_SYSTEM_FAILED');
        const candidates = voices.filter(v => typeof v.name === 'string' && v.name.length <= 200 && /^zh-/i.test(v.culture));
        voice = (candidates.find(v => v.culture === 'zh-CN' && /Huihui Desktop/i.test(v.name)) ?? candidates.find(v => v.culture === 'zh-CN') ?? candidates[0])?.name;
        if (!voice) throw Error('VOICE_REPLY_CHINESE_MISSING');
        fs.mkdirSync(this.root, { recursive: true }); assertPlain(this.root);
        const checked = await this.systemAudio({ text: '你好，我已经准备好用语音回复你了。', directory: this.root, id: 'setup-' + randomUUID(), voice, signal });
        try{if(prepareTranscription)transcription=await prepareTranscription({file:checked.file,signal});}
        finally{if(fs.existsSync(checked.file))fs.unlinkSync(checked.file);}
      }
      signal.throwIfAborted();
      const value = { format: 'chatagent-voice-replies-v1', source, voice,...transcription?{transcription}:{} };
      fs.mkdirSync(this.root, { recursive: true }); assertPlain(this.root); assertPlain(this.file);
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' }); fs.renameSync(temporary, this.file);
      return this.read();
    });
  }
  async preview() {
    return this.exclusive(async signal => {
      const current = this.settings(); if (!['system','mansui'].includes(current.source)) throw Error('VOICE_REPLY_PREVIEW_REQUIRES_SYSTEM');
      fs.mkdirSync(this.root, { recursive: true }); assertPlain(this.root);
      const request={text:'你好，今天也一起聊天吧。',directory:this.root,id:'preview-'+randomUUID(),voice:current.voice,signal};
      const result=current.source==='mansui'?await this.mansui.synthesize(request):await this.systemAudio(request);
      const bytes = fs.readFileSync(result.file);
      fs.unlinkSync(result.file);
      return { mediaType: 'audio/wav', data: bytes.toString('base64'), seconds: result.seconds, sha256: result.sha256 };
    });
  }
  async synthesize(request) {
    const current = this.settings();
    if(current.source==='mansui')return this.exclusive(signal=>this.mansui.synthesize({...request,signal:request.signal?AbortSignal.any([signal,request.signal]):signal}));
    if (current.source === 'existing') return this.legacy.synthesize(request);
    if (current.source !== 'system') throw Error('VOICE_REPLY_NOT_CONFIGURED');
    return this.exclusive(signal => this.systemAudio({ ...request, voice: current.voice, signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal }));
  }
  async close() { this.closed = true; for (const controller of this.controllers) controller.abort(); await this.legacy?.close(); }
}

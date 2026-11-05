import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = '这条语音未能可靠转写，录音原件已保存；没有将它发送给对话模型，也不会自动重试。请重新录音或改用文字。';
const unsupported = '已保存附件。目前只支持语音转写；这条消息含有无法读取的附件，没有发送给对话模型。请单独发送语音或文字。';

// Lives in the native runtime ledger, so backups/restores carry the exact model
// input. A lookup may only read this record; it must never run ASR or the model.
export function createAudioInput({ db, root, recognize }) {
  db.exec("CREATE TABLE IF NOT EXISTS audio_inputs(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,text TEXT,reply TEXT); UPDATE audio_inputs SET state='unknown' WHERE state='running'");
  db.exec("CREATE TABLE IF NOT EXISTS audio_transcripts(sha256 TEXT PRIMARY KEY,state TEXT NOT NULL,text TEXT,error TEXT); UPDATE audio_transcripts SET state='unknown' WHERE state IN ('queued','running')");
  let delivery;
  const fingerprint = request => hash([request.mode, request.text, request.attachments]);
  function saved(request) {
    const row = db.prepare('SELECT * FROM audio_inputs WHERE id=?').get(request.id);
    if (row && row.fingerprint !== fingerprint(request)) throw Error('DSH_REQUEST_ID_REUSED');
    return row;
  }
  function resolved(request, row) {
    if (!row || ['unknown', 'running'].includes(row.state)) throw Error('ASR_RESULT_UNKNOWN');
    return row.state === 'failed' ? { failure: row.reply } : { ...request, text: row.text, audioTranscription: true, attachments: [] };
  }
  return {
    attach(binding) { delivery = binding; },
    lookup(request) { return resolved(request, saved(request)); },
    transcription(id) {
      const file=delivery.attachments.verify(id), row=db.prepare('SELECT state,text,error FROM audio_transcripts WHERE sha256=?').get(file.sha256);
      return row ? { ...row } : { state:'not-requested' };
    },
    requestTranscription(id, schedule) {
      const file=delivery.attachments.verify(id);
      if(!file.media_type.startsWith('audio/'))throw Error('ASR_UNSUPPORTED_ATTACHMENT');
      const old=this.transcription(id);if(old.state!=='not-requested')return old;
      db.prepare("INSERT INTO audio_transcripts VALUES(?,'queued',NULL,NULL)").run(file.sha256);
      schedule(async()=>{
        const current=db.prepare('SELECT state FROM audio_transcripts WHERE sha256=?').get(file.sha256);
        if(current?.state==='completed')return;
        db.prepare("UPDATE audio_transcripts SET state='running' WHERE sha256=?").run(file.sha256);
        try{
          const duration=delivery.attachments.audioDuration(id);
          if(!duration||duration>1800000)throw Error('ASR_AUDIO_DURATION_UNSUPPORTED');
          const parts=[],signal=AbortSignal.timeout(600000);
          const count=Math.ceil(duration/120000), segment=duration/count;
          for(let index=0;index<count;index++){
            const directory=path.join(root,'audio-transcripts',file.sha256,String(index));fs.mkdirSync(directory,{recursive:true});
            const result=await recognize({file:file.file,directory,signal,offsetSeconds:index*segment/1000,segmentSeconds:segment/1000});
            if(typeof result.text!=='string'||!/[\p{L}\p{N}]/u.test(result.text)||result.text.length>16000)throw Error('ASR_RESULT_INVALID');
            parts.push(result.text.trim());
          }
          db.prepare("UPDATE audio_transcripts SET state='completed',text=? WHERE sha256=?").run(parts.join('\n'),file.sha256);
        }catch(error){db.prepare("UPDATE audio_transcripts SET state='failed',error=? WHERE sha256=?").run(/^ASR_[A-Z_]+$/.test(error.message)?error.message:'ASR_FAILED',file.sha256);}
      });
      return {state:'queued'};
    },
    async prepare(request) {
      const old = saved(request); if (old) return resolved(request, old);
      db.prepare("INSERT INTO audio_inputs VALUES(?,?,'running',NULL,NULL)").run(request.id, fingerprint(request));
      const files = request.attachments;
      let text;
      try {
        if (!files.length || files.length > 8 || files.some(f => !['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/webm'].includes(f.mediaType))) throw Error('ASR_UNSUPPORTED_ATTACHMENT');
        const parts = [];
        for (const item of files) {
          const checked = delivery.attachments.verify(item.id);
          if (checked.sha256 !== item.sha256 || checked.bytes !== item.bytes || checked.media_type !== item.mediaType) throw Error('ASR_ATTACHMENT_CHANGED');
          const directory = path.join(root, 'audio-input', request.id, item.id); fs.mkdirSync(directory, { recursive: true });
          const result = await recognize({ file: checked.file, directory, signal: AbortSignal.timeout(150000) });
          // ASR may emit punctuation for room noise. Nonempty is insufficient:
          // only a transcript containing a letter or number can enter dialogue.
          if (typeof result.text !== 'string' || !/[\p{L}\p{N}]/u.test(result.text) || result.text.length > 16000) throw Error('ASR_RESULT_INVALID');
          parts.push(result.text.trim());
          db.prepare("INSERT INTO audio_transcripts VALUES(?,'completed',?,NULL) ON CONFLICT(sha256) DO UPDATE SET state='completed',text=excluded.text,error=NULL WHERE audio_transcripts.state='queued'").run(item.sha256,result.text.trim());
        }
        text = [request.text.trim(), ...parts].filter(Boolean).join('\n'); if (text.length > 32000) throw Error('ASR_TEXT_LIMIT');
        db.prepare("UPDATE audio_inputs SET state='completed',text=? WHERE id=?").run(text, request.id);
      } catch (error) {
        const reply = error.message === 'ASR_UNSUPPORTED_ATTACHMENT' ? unsupported : failure;
        db.prepare("UPDATE audio_inputs SET state='failed',reply=? WHERE id=?").run(reply, request.id);
        return { failure: reply };
      }
      return { ...request, text, audioTranscription: true, attachments: [] };
    }
  };
}

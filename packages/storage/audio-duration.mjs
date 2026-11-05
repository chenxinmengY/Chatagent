import { execFileSync } from 'node:child_process';

export function probeAudioDuration(file) {
  try {
    const result = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','json',file], { windowsHide:true, timeout:10000, maxBuffer:32768, encoding:'utf8', stdio:['ignore','pipe','pipe'] }));
    const ms = Math.ceil(Number(result.format?.duration) * 1000);
    return Number.isSafeInteger(ms) && ms > 0 && ms <= 86400000 ? ms : null;
  } catch { return null; }
}

// Isolated feasibility prototype. No access to chat, accounts or credentials.
export function makeChunks(lines, limit = 900) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid limit');
  const chunks = []; let current = '';
  for (const source of lines) {
    let line = String(source).trim();
    while (line.length) {
      const separator = current ? '\n' : '';
      const available = limit - current.length - separator.length;
      if (available <= 0) { chunks.push(current); current = ''; continue; }
      if (line.length <= available) { current += separator + line; break; }
      if (current) { chunks.push(current); current = ''; continue; }
      chunks.push(line.slice(0, limit)); line = line.slice(limit);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
export function nextChunk(job, chatBusy) {
  if (job.status === 'stopped' || chatBusy || job.cursor >= job.chunks.length) return null;
  return { index: job.cursor, text: job.chunks[job.cursor], source: job.source };
}
export function acknowledge(job, index) {
  if (job.status === 'stopped' || index !== job.cursor || index >= job.chunks.length) return false;
  job.cursor++; if (job.cursor === job.chunks.length) job.status = 'finished'; return true;
}
export function stop(job) { job.status = 'stopped'; }

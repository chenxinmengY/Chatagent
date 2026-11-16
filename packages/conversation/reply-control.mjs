// Empty thinking wrappers are formatting controls; preserve code examples and nonempty blocks.
export function stripEmptyThinking(text) {
  let fence = null, pending = [];
  const blocks = [];
  const flush = () => {
    if (!pending.length) return;
    blocks.push(pending.join('\n').replace(/(`+)[\s\S]*?\1|<thinking\s*>\s*<\/thinking\s*>/gi, (match, code) => code ? match : ''));
    pending = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/.exec(line);
    if (marker) {
      flush();
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      blocks.push(line);
    } else if (fence) blocks.push(line);
    else pending.push(line);
  }
  flush();
  const result = blocks.join('\n');
  return result === text ? text : result.trim();
}

// Strip bare silence controls, preserving quoted words and fenced examples.
export function visibleReplyText(text) {
  let fence = null;
  const lines = [];
  for (const line of stripEmptyThinking(text).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      lines.push(line); continue;
    }
    if (fence) { lines.push(line); continue; }
    if (/^\s*SILENT(?:\s+SILENT)*\s*$/.test(line)) continue;
    lines.push(line.replace(/([。！？.!?…])(?:[\t ]*SILENT)+[\t \r]*$/, '$1'));
  }
  const result = lines.join('\n');
  return result === text ? text : result.trim();
}

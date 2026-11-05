import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertPlain } from '../migration/standby-capture.mjs';

// A Python installation has tens of thousands of files. Check each distinct
// parent directory before and after the scan instead of walking the same chain
// twice per file. Every file is still opened, hashed in full and identity-checked.
export function verifyInstallationFiles(root, files) {
  assertPlain(root); const names = new Set(), parents = new Set(), block = Buffer.alloc(65536);
  for (const item of files) {
    if (typeof item.file !== 'string' || /[\\:]/.test(item.file) || item.file.split('/').some(x => !x || x === '.' || x === '..') || path.isAbsolute(item.file) || names.has(item.file)) throw Error('SINGING_INSTALLATION_PATH');
    names.add(item.file); const file = path.join(root, item.file), parent = path.dirname(file);
    if (!parents.has(parent)) { assertPlain(parent); parents.add(parent); }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== item.bytes) throw Error('SINGING_INSTALLATION_CHANGED');
    const fd = fs.openSync(file, 'r'), digest = createHash('sha256'); let count = 0;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error('SINGING_INSTALLATION_CHANGED');
      let length; while ((length = fs.readSync(fd, block, 0, block.length, null))) { digest.update(block.subarray(0, length)); count += length; }
      const after = fs.fstatSync(fd), current = fs.lstatSync(file);
      if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || digest.digest('hex') !== item.sha256) throw Error('SINGING_INSTALLATION_CHANGED');
    } finally { fs.closeSync(fd); }
  }
  for (const parent of parents) assertPlain(parent);
  return names;
}

import path from 'node:path';
import { AttachmentStore } from '../packages/storage/attachments.mjs';

const [destination, ...files] = process.argv.slice(2);
if (!destination || !files.length) throw Error('Usage: node scripts/import-attachments.mjs <isolated-attachment-root> <file> [file...]');
const store = new AttachmentStore(path.resolve(destination));
try {
  const results = files.map(file => store.importFile(path.resolve(file)));
  console.log(JSON.stringify({ sourceFilesModified: false, chatMessagesCreated: false, attachments: results }, null, 2));
} finally { store.close(); }

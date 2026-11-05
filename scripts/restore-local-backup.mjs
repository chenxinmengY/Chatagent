import { restoreLocalBackup } from '../packages/migration/local-restore.mjs';
import path from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) throw Error('Usage: node scripts/restore-local-backup.mjs ABSOLUTE_BACKUP_DIRECTORY ABSOLUTE_NEW_DIRECTORY');
console.log(JSON.stringify(restoreLocalBackup(source, destination), null, 2));

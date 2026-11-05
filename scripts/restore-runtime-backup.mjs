import { restoreRuntimeBackup } from '../packages/migration/runtime-backup.mjs';

if (process.argv.length !== 4) throw Error('Usage: node scripts/restore-runtime-backup.mjs <backup-directory> <new-target-directory>');
console.log(JSON.stringify(restoreRuntimeBackup(process.argv[2], process.argv[3]), null, 2));

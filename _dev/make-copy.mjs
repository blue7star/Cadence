import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const src = process.argv[2] || 'data/workbench.db';
const dest = process.argv[3];
if (!dest) { console.error('用法：node _dev/make-copy.mjs <源库> <目标库>'); process.exit(2); }
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) fs.rmSync(dest);
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log(JSON.stringify({ src, dest }));

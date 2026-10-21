/** Runs a .sql file (statements separated by ';' at line end) and prints the last result as a table. */
import { readFile } from 'node:fs/promises';
import { createPool } from './db.js';

const file = process.argv[2];
if (!file) throw new Error('usage: npm run sql -- <file.sql>');
const sql = await readFile(new URL(file, `file://${process.env.INIT_CWD ?? process.cwd()}/`), 'utf8');
const statements = sql.split(/;\s*$/m).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
const pool = createPool();
try {
  const client = await pool.connect();
  await client.query("SET statement_timeout = '30min'");
  let last;
  for (const [i, s] of statements.entries()) {
    const t0 = Date.now();
    last = await client.query(s);
    console.error(`[sql] ${i + 1}/${statements.length} ${((Date.now() - t0) / 1000).toFixed(1)}s ${s.split('\n')[0].slice(0, 70)}`);
  }
  client.release();
  if (last?.rows?.length) console.table(last.rows);
} finally {
  await pool.end();
}

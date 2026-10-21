import { readFile } from 'node:fs/promises';
import { createPool } from './db.js';

const schemaPath = new URL('../../../db/schema.sql', import.meta.url);

const pool = createPool();
try {
  await pool.query(await readFile(schemaPath, 'utf8'));
  console.log(`[migrate] applied ${schemaPath.pathname}`);
} finally {
  await pool.end();
}

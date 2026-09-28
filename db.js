// Database access.
//
// There is no database server to install and no disk to mount:
//
//   TURSO_DATABASE_URL set -> a managed Turso database reached over HTTPS
//   unset                  -> a plain local SQLite file, used in development
//
// Turso speaks SQLite, so the SQL, the schema and the tests are unchanged, and
// local development needs no account, no network and no native module to build.
// Because one variable decides everything, the same code also still runs against
// a mounted disk simply by pointing STORAGE_DIR at it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where the local SQLite file lives in file mode. Ignored against a remote
// database, where the host's filesystem holds nothing that matters.
export const STORAGE_DIR = path.resolve(__dirname, process.env.STORAGE_DIR || './storage');

const REMOTE = String(process.env.TURSO_DATABASE_URL || '').trim();
export const USING_REMOTE_DB = !!REMOTE;

if (!REMOTE) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// A Turso URL looks like libsql://<database>-<org>.turso.io. The local form is
// understood by the same client, which is what keeps development and production
// on one code path.
export const DB_URL = REMOTE || 'file:' + path.join(STORAGE_DIR, 'khusela.db');

const client = createClient({
  url: DB_URL,
  authToken: REMOTE ? (process.env.TURSO_AUTH_TOKEN || undefined) : undefined,
});

export async function all(sql, args = []) {
  return (await client.execute({ sql, args })).rows;
}

export async function get(sql, args = []) {
  return (await client.execute({ sql, args })).rows[0] || null;
}

export async function run(sql, args = []) {
  return client.execute({ sql, args });
}

// Several statements in one atomic round trip: either all of them are stored or
// none are. That is what keeps a captured signature and the "used" marker on its
// signing link from ever drifting apart.
export async function write(statements) {
  return client.batch(statements, 'write');
}

// Schema and migration statements run one at a time so that a failure names the
// exact statement that broke instead of an anonymous batch.
export async function ddl(statements) {
  for (const sql of statements) await client.execute(sql);
}

// SQLite reports a duplicate value in a UNIQUE column as SQLITE_CONSTRAINT_UNIQUE
// ("UNIQUE constraint failed: signatures.invitation_id"). Routes turn that into a
// 409, which is what stops a signing link being used twice.
export function isUniqueViolation(e) {
  const text = String(e?.cause?.code || e?.code || '') + ' ' + String(e?.message || '');
  return text.includes('UNIQUE');
}

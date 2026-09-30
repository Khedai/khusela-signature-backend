// Verifies that a database created by the previous version of the server is
// migrated in place (new columns added, existing invitations untouched).
//   node tools/test_migration.js
import { createClient } from '@libsql/client';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 3902;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'storage', '_mig_test.db');
// The database address in the same shape db.js builds it for TURSO_DATABASE_URL.
const DB_URL = 'file:./storage/_mig_test.db';

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
// The folder is not in git — only the databases inside it are ignored — and db.js
// creates it only for its own default path, so a fresh checkout has nowhere for a
// scratch database to live.
fs.mkdirSync(path.dirname(DB), { recursive: true });

// Build the database exactly as the previous version of server.js left it: no
// manage_token_hash / signer_label / application_ref, no documents table, and
// signatures holding a file name instead of the image bytes themselves.
const legacy = createClient({ url: DB_URL });
await legacy.batch([
  { sql: `CREATE TABLE invitations(
       id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL,
       id_number TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, application_type TEXT,
       debit_amount TEXT, debit_date TEXT, consultant TEXT, branch TEXT,
       created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
       status TEXT NOT NULL DEFAULT 'pending')`, args: [] },
  { sql: `CREATE TABLE signatures(
       id TEXT PRIMARY KEY, invitation_id TEXT UNIQUE NOT NULL, signature_file TEXT NOT NULL,
       signed_at TEXT NOT NULL, ip TEXT, user_agent TEXT)`, args: [] },
  { sql: 'INSERT INTO invitations(id,token_hash,client_name,id_number,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?)',
    args: ['legacy-1', 'hash-1', 'Existing Client', '8001015800081', new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(), 'pending'] },
], 'write');
legacy.close();

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), TURSO_DATABASE_URL: DB_URL, PUBLIC_BASE_URL: BASE,
    ALLOWED_ORIGINS: '*', ADMIN_API_KEY: 'test-key',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/sign/nope'); if (r.status === 404) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let inspector = null;
try {
  check('server starts against the old database', await waitReady());

  // The server has already created its tables and added its columns by now, so a
  // second client on the same file sees the migrated schema.
  inspector = createClient({ url: DB_URL });
  const columns = async (table) =>
    (await inspector.execute('PRAGMA table_info(' + table + ')')).rows.map((c) => c.name);

  const cols = await columns('invitations');
  check('manage_token_hash column added', cols.includes('manage_token_hash'), cols.join(','));
  check('signer_label column added', cols.includes('signer_label'));
  check('application_ref column added', cols.includes('application_ref'));

  const sigCols = await columns('signatures');
  check('signature_file kept for old rows, signature_data added for the new ones',
    sigCols.includes('signature_file') && sigCols.includes('signature_data'), sigCols.join(','));

  const docCols = await columns('documents');
  check('documents table created with a content BLOB', docCols.includes('content'), docCols.join(','));

  const admin = await fetch(BASE + '/api/admin/invites', { headers: { 'x-admin-key': 'test-key' } });
  const adminBody = await admin.json();
  check('pre-existing invitation still listed', admin.status === 200 && adminBody.rows.length === 1 && adminBody.rows[0].client_name === 'Existing Client',
    JSON.stringify(adminBody).slice(0, 200));

  const inv = await (await fetch(BASE + '/api/invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'New Client', idNumber: '9001015800085', signerLabel: 'Applicant 1' }),
  })).json();
  const man = await (await fetch(BASE + '/api/manage/' + inv.manageToken)).json();
  check('new signing request works on the migrated database', man.status === 'pending' && man.signerLabel === 'Applicant 1',
    JSON.stringify(man));
} catch (e) {
  fail++;
  console.log('  FAIL exception -- ' + (e && e.message));
} finally {
  try { if (inspector) inspector.close(); } catch (e) {}
  child.kill();
  // The database file stays locked for a moment after the last handle is dropped,
  // so retry rather than giving up on the first refusal.
  for (let attempt = 0; ; attempt++) {
    try {
      for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
      break;
    } catch (e) {
      if (attempt >= 19) { console.log('  note: ' + DB + ' is still locked; the next run deletes it first.'); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

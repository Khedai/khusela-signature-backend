// Verifies that a database created by the previous version of the server is
// migrated in place (new columns added, existing invitations untouched).
//   node tools/test_migration.js
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 3902;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, 'storage', '_mig_test.db');

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }

// Build the database exactly as the previous version of server.js left it.
const legacy = new Database(DB);
legacy.exec(`
CREATE TABLE invitations(
 id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL,
 id_number TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, application_type TEXT,
 debit_amount TEXT, debit_date TEXT, consultant TEXT, branch TEXT,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE signatures(
 id TEXT PRIMARY KEY, invitation_id TEXT UNIQUE NOT NULL, signature_file TEXT NOT NULL,
 signed_at TEXT NOT NULL, ip TEXT, user_agent TEXT
);
`);
legacy.prepare('INSERT INTO invitations(id,token_hash,client_name,id_number,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?)')
  .run('legacy-1', 'hash-1', 'Existing Client', '8001015800081', new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(), 'pending');
legacy.close();

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: './storage/_mig_test.db', PUBLIC_BASE_URL: BASE,
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

try {
  check('server starts against the old database', await waitReady());

  const cols = new Database(DB).prepare('PRAGMA table_info(invitations)').all().map((c) => c.name);
  check('manage_token_hash column added', cols.includes('manage_token_hash'), cols.join(','));
  check('signer_label column added', cols.includes('signer_label'));
  check('application_ref column added', cols.includes('application_ref'));

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
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

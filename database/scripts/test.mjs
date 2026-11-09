import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const container = `booking-db-test-${Date.now()}`;
const image = process.env.POSTGRES_IMAGE || 'postgres:17.6-bookworm';
const run = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout;
};
function sql(query) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'booking_test', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: query, encoding: 'utf8', timeout: 30000,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result.stdout.trim();
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (check()) return; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
function session(name) {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${name}`, container, 'psql', '-X', '-U', 'postgres', '-d', 'booking_test', '-v', 'ON_ERROR_STOP=1', '-At']);
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, output, errors }));
  });
  return { child, done, output: () => output };
}
let started = false;
try {
  run('run', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=booking_test', image);
  started = true;
  await until(() => {
    try { return run('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'booking_test').includes('accepting'); }
    catch { return false; }
  }, 'PostgreSQL readiness');
  console.log(sql('SELECT version();'));
  sql('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);');
  for (const name of readdirSync(resolve(root, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    assert.match(name, /^\d+_[a-z_]+\.sql$/);
    if(name==='004_hotels.sql') sql("INSERT INTO rooms(id,name) VALUES('90000000-0000-4000-8000-000000000099','Legacy room');");
    sql(`BEGIN;\n${readFileSync(resolve(root, 'migrations', name), 'utf8')}\nINSERT INTO schema_migrations(version) VALUES ('${name}');\nCOMMIT;`);
  }
  assert.equal(sql("SELECT hotel_id::text FROM rooms WHERE id='90000000-0000-4000-8000-000000000099';"),'80000000-0000-4000-8000-000000000001');
  sql("DELETE FROM rooms WHERE id='90000000-0000-4000-8000-000000000099';");
  console.log('PASS existing rooms preserved by hotel migration');
  const seed = readFileSync(resolve(root, 'seeds/001_room.sql'), 'utf8');
  sql(seed); sql(seed);
  assert.equal(sql('SELECT count(*) FROM rooms;'), '12');
  sql("UPDATE rooms SET is_active = FALSE;" + seed);
  assert.equal(sql('SELECT count(*) FROM rooms WHERE is_active=FALSE;'), '12');
  sql('UPDATE rooms SET is_active = TRUE;');
  console.log('PASS migration from empty DB and idempotent, non-overwriting seed');
  console.log(sql(readFileSync(resolve(root, 'tests/constraints.sql'), 'utf8')));

  const insert = `INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email) VALUES ('10000000-0000-4000-8000-000000000001','7c71298a-ef46-457c-ab5e-9edb238a54e5','2030-01-10','2030-01-12','Guest','+66812345678','guest@example.com');`;
  // A holds an uncommitted booking; B must demonstrably wait for its transaction.
  for (const action of ['COMMIT', 'ROLLBACK']) {
    sql('DELETE FROM bookings;');
    const a = session('booking_race_a');
    const b = session('booking_race_b');
    try {
      a.child.stdin.write(`BEGIN; ${insert} SELECT 'A_READY';\n`);
      await until(() => a.output().includes('A_READY'), 'A inserted without commit');
      b.child.stdin.end(insert);
      await until(() => sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='booking_race_b' AND wait_event_type='Lock';") === '1', 'B blocked on real database lock');
      a.child.stdin.end(`${action};\n`);
      const [resultA, resultB] = await Promise.all([a.done, b.done]);
      assert.equal(resultA.code, 0, resultA.errors);
      if (action === 'COMMIT') {
        assert.notEqual(resultB.code, 0);
        assert.match(resultB.errors, /prevent_overlapping_bookings/);
      } else assert.equal(resultB.code, 0, resultB.errors);
      assert.equal(sql('SELECT count(*) FROM bookings;'), '1');
      console.log(`PASS concurrent booking: first ${action}, waiting request ${action === 'COMMIT' ? 'conflicts' : 'succeeds'}`);
    } finally {
      a.child.stdin.end(); b.child.stdin.end();
      sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('booking_race_a','booking_race_b');");
    }
  }
  // Shared room locks allow other bookings but prevent a room closing mid-booking.
  const reader = session('room_lock_reader');
  const writer = session('room_lock_writer');
  try {
    reader.child.stdin.write("BEGIN; SELECT id FROM rooms WHERE id='7c71298a-ef46-457c-ab5e-9edb238a54e5' FOR SHARE; SELECT 'ROOM_LOCKED';\n");
    await until(() => reader.output().includes('ROOM_LOCKED'), 'shared room lock acquired');
    writer.child.stdin.end("UPDATE rooms SET is_active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE id='7c71298a-ef46-457c-ab5e-9edb238a54e5';\n");
    await until(() => sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='room_lock_writer' AND wait_event_type='Lock';") === '1', 'room closure waits');
    reader.child.stdin.end('COMMIT;\n');
    const results = await Promise.all([reader.done, writer.done]);
    for (const result of results) assert.equal(result.code, 0, result.errors);
    assert.equal(sql("SELECT is_active FROM rooms WHERE id='7c71298a-ef46-457c-ab5e-9edb238a54e5';"), 'f');
    console.log('PASS room closure waits for shared transaction lock');
  } finally {
    reader.child.stdin.end(); writer.child.stdin.end();
    sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('room_lock_reader','room_lock_writer');");
  }
  console.log('PASS all database checks (API/service coverage not yet applicable)');
} finally {
  if (started) run('rm', '-f', '-v', container);
}

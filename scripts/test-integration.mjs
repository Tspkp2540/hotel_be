import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const name = `booking-auth-test-${Date.now()}`;
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result.stdout.trim();
}
let started = false, pool, server;
try {
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=booking_auth_test', 'postgres:17.6-bookworm');
  started = true;
  const port = docker('inspect', '-f', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name);
  const url = `postgresql://postgres@127.0.0.1:${port}/booking_auth_test`;
  pool = new Pool({ connectionString: url });
  const deadline = Date.now() + 30000;
  while (true) {
    try { await pool.query('SELECT 1'); break; }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(r => setTimeout(r, 150)); }
  }
  const migrations = new URL('../database/migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(readFileSync(new URL(file, migrations), 'utf8')); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  await pool.query(readFileSync(new URL('../database/seeds/001_room.sql', import.meta.url), 'utf8'));
  // Real TCP smoke test of the compiled process, beyond Fastify's in-process injection.
  server = spawn(process.execPath, ['dist/server.js'], {
    cwd, env: { ...process.env, DATABASE_URL: url, FRONTEND_ORIGIN: 'http://localhost:3000', PORT: '0', NODE_ENV: 'development', MAX_BOOKING_NIGHTS: '30', MAX_ADVANCE_DAYS: '365' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  let serverError;
  server.on('error', error => { serverError = error; });
  const smokeDeadline = Date.now() + 15000;
  while (!logs.match(/http:\/\/127\.0\.0\.1:\d+/)) {
    if (serverError || server.exitCode !== null || Date.now() > smokeDeadline) throw new Error('Server startup failed: ' + logs);
    await new Promise(r => setTimeout(r, 100));
  }
  const address = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const response = await fetch(address + '/api/v1/auth/me');
  if (response.status !== 401 || (await response.json()).error.code !== 'UNAUTHORIZED') throw new Error('Server TCP smoke test failed');
  for (const path of ['/api/v1/rooms', '/api/v1/rooms/7c71298a-ef46-457c-ab5e-9edb238a54e5/calendar?from=2026-11-01&to=2026-12-01']) {
    if ((await fetch(address + path)).status !== 401) throw new Error('Rooms/calendar must require login');
  }
  const smokeCredentials = { email: 'smoke@example.com', password: 'smoke-password-123' };
  const post = (path, body, cookie) => fetch(address + path, {
    method: 'POST', headers: { origin: 'http://localhost:3000', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const registration = await post('/api/v1/auth/register', { ...smokeCredentials, fullName: 'Smoke Reviewer' });
  if (registration.status !== 201) throw new Error('Real HTTP register failed');
  const login = await post('/api/v1/auth/login', smokeCredentials);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (login.status !== 200 || !cookie) throw new Error('Real HTTP login failed');
  const roomsResponse = await fetch(address + '/api/v1/rooms', { headers: { cookie } });
  const rooms = (await roomsResponse.json()).data.rooms;
  if (roomsResponse.status !== 200 || rooms.length !== 5) throw new Error('Real HTTP rooms failed');
  const calendarResponse = await fetch(address + `/api/v1/rooms/${rooms[0].id}/calendar?from=2026-11-01&to=2026-12-01`, { headers: { cookie } });
  const calendar = (await calendarResponse.json()).data;
  if (calendarResponse.status !== 200 || calendar.bookedRanges.length !== 0 || calendar.bookingRules.maxNights !== 30) throw new Error('Real HTTP calendar failed');
  const bookingInput = {
    roomId: rooms[0].id, checkIn: calendar.today,
    checkOut: new Date(Date.parse(calendar.today) + 86400000).toISOString().slice(0,10),
    guestName: 'Smoke Guest', guestPhone: '+66812345678', guestEmail: 'smoke-guest@example.com',
  };
  const booked = await post('/api/v1/bookings', bookingInput, cookie);
  if (booked.status !== 201 || (await booked.json()).data.booking.nights !== 1) throw new Error('Real HTTP booking failed');
  const secondCredentials = { email: 'smoke-second@example.com', password: 'smoke-password-456' };
  if ((await post('/api/v1/auth/register', { ...secondCredentials, fullName: 'Second Reviewer' })).status !== 201) throw new Error('Second registration failed');
  const secondLogin = await post('/api/v1/auth/login', secondCredentials);
  const secondCookie = secondLogin.headers.get('set-cookie')?.split(';')[0];
  if (secondLogin.status !== 200 || !secondCookie) throw new Error('Second login failed');
  const conflict = await post('/api/v1/bookings', bookingInput, secondCookie);
  if (conflict.status !== 409 || (await conflict.json()).error.code !== 'BOOKING_CONFLICT') throw new Error('Real HTTP conflict failed');
  const refreshed = await fetch(address + `/api/v1/rooms/${rooms[0].id}/calendar?from=${bookingInput.checkIn}&to=${bookingInput.checkOut}`, { headers: { cookie: secondCookie } });
  if ((await refreshed.json()).data.bookedRanges.length !== 1) throw new Error('Calendar read-after-booking failed');
  const adjacent = await post('/api/v1/bookings', { ...bookingInput, checkIn: bookingInput.checkOut, checkOut: new Date(Date.parse(bookingInput.checkOut)+86400000).toISOString().slice(0,10) }, secondCookie);
  if (adjacent.status !== 201) throw new Error('Real HTTP adjacent booking failed');
  if ((await post('/api/v1/auth/logout', undefined, cookie)).status !== 204) throw new Error('Real HTTP logout failed');
  if ((await fetch(address + '/api/v1/rooms', { headers: { cookie } })).status !== 401) throw new Error('Logged-out session still authorized');
  console.log('PASS compiled server HTTP flow: register/login/rooms/calendar/book/conflict/refresh/adjacent/logout');
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--coverage'], {
    cwd, env: { ...process.env, TEST_DATABASE_URL: url }, stdio: 'inherit', timeout: 180000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    const closed = new Promise(resolve => server.once('close', resolve));
    server.kill();
    await closed;
  }
  await pool?.end();
  if (started) docker('rm', '-f', '-v', name);
}

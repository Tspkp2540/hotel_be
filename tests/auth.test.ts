import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { buildTestApp as buildApp } from './support/contract-app.js';
import { AuthService, passwordHasher, SESSION_MS, tokenHash } from '../src/auth/service.js';
import type { AuthRepository, CredentialUser, Session } from '../src/auth/repository.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { Pool } from 'pg';
import { loginSchema, registerSchema, validate } from '../src/auth/validation.js';

const origin = 'http://localhost:3000';
const headers = { origin };
const input = { email: 'guest@example.com', password: '  secure-password  ', fullName: 'สมชาย ใจดี' };
const user = { id: '10000000-0000-4000-8000-000000000001', email: input.email, fullName: input.fullName, createdAt: '2026-11-06T00:00:00.000Z' };
class MemoryRepository implements AuthRepository {
  users = new Map<string, CredentialUser>();
  sessions = new Map<string, Session>();
  async createUser(email: string, passwordHash: string, fullName: string) {
    if (this.users.has(email)) throw { code: '23505', constraint: 'users_email_lower_uidx' };
    const result = { ...user, email, fullName };
    this.users.set(email, { ...result, passwordHash }); return result;
  }
  async findUser(email: string) { return this.users.get(email); }
  async createSession(_userId: string, hash: string, _now: Date, expiresAt: Date) { this.sessions.set(hash, { user, expiresAt }); }
  async findSession(hash: string) { return this.sessions.get(hash); }
  async deleteSession(hash: string) { this.sessions.delete(hash); }
}

describe('Auth API contract (memory or actual PostgreSQL)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repository: AuthRepository;
  let pool: Pool | undefined;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-11-06T00:00:00.000Z');
    if (process.env.TEST_DATABASE_URL) {
      pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await pool.query('TRUNCATE sessions,bookings,users CASCADE');
      repository = new PgAuthRepository(pool);
    } else repository = new MemoryRepository();
    app = await buildApp({ repository, frontendOrigin: origin, clock: () => now });
  });
  afterEach(async () => { await app.close(); await pool?.end(); });
  const register = (app: Awaited<ReturnType<typeof buildApp>>, payload = input) => app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload });
  const login = (app: Awaited<ReturnType<typeof buildApp>>, payload = { email: input.email, password: input.password }) => app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload });

  it('registers normalized fields, hashes password, does not automatically login or expose secrets', async () => {
    const response = await register(app, { ...input, email: ' GUEST@example.com ', fullName: ' สมชาย ใจดี ' });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.user).toMatchObject({ email: input.email, fullName: input.fullName });
    expect(response.headers['set-cookie']).toBeUndefined();
    const saved = await repository.findUser(input.email);
    expect(saved?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await passwordHasher.verify(saved!.passwordHash, input.password)).toBe(true);
    expect(response.body).not.toMatch(/password|token/i);
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
  });
  it('rejects NUL in fullName before database persistence', async () => {
    const create=vi.spyOn(repository,'createUser');
    const response=await register(app,{...input,fullName:'Guest\u0000Name'});
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual(expect.arrayContaining([expect.objectContaining({field:'fullName',code:'INVALID_FORMAT'})]));
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects duplicate email and leaves one user', async () => {
    await register(app);
    const response = await register(app, { ...input, email: 'GUEST@example.com' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
    if (pool) expect((await pool.query('SELECT count(*) FROM users')).rows[0].count).toBe('1');
  });
  it('concurrent register yields one user and one duplicate response', async () => {
    const results = await Promise.all([register(app), register(app, { ...input, email: 'GUEST@example.com' })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    if (pool) expect((await pool.query('SELECT count(*) FROM users')).rows[0].count).toBe('1');
  });
  it('login, me, logout and repeat logout; other device remains valid', async () => {
    await register(app);
    const response = await login(app);
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies[0];
    expect(cookie.name).toBe('booking_session');
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']).toContain('Path=/');
    expect(response.headers['set-cookie']).not.toContain('Domain=');
    expect(response.json().data.sessionExpiresAt).toBe('2026-11-13T00:00:00.000Z');
    expect(response.body).not.toMatch(/password|token/i);
    expect(await repository.findSession(cookie.value)).toBeUndefined();
    expect(await repository.findSession(tokenHash(cookie.value))).toBeDefined();
    const second = await login(app);
    const cookies = { [cookie.name]: cookie.value };
    const me = await app.inject({ url: '/api/v1/auth/me', cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toEqual(response.json().data);
    expect(me.headers['set-cookie']).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers, cookies })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/auth/me', cookies })).statusCode).toBe(401);
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers, cookies });
    expect(again.statusCode).toBe(204); expect(again.body).toBe('');
    expect(again.headers['set-cookie']).toContain('Max-Age=0');
    expect((await app.inject({ url: '/api/v1/auth/me', cookies: { booking_session: second.cookies[0].value } })).statusCode).toBe(200);
  });
  it('rejects missing, malformed, unknown and expired sessions at exact expiry', async () => {
    for (const token of [undefined, 'invalid', 'a'.repeat(43)]) {
      expect((await app.inject({ url: '/api/v1/auth/me', cookies: token ? { booking_session: token } : undefined })).statusCode).toBe(401);
    }
    await register(app); const response = await login(app);
    const cookies = { booking_session: response.cookies[0].value };
    now = new Date(now.getTime() + SESSION_MS - 1);
    expect((await app.inject({ url: '/api/v1/auth/me', cookies })).statusCode).toBe(200);
    now = new Date(now.getTime() + 1);
    expect((await app.inject({ url: '/api/v1/auth/me', cookies })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers, cookies })).statusCode).toBe(204);
  });
  it('wrong password and missing user yield identical errors with no new session', async () => {
    await register(app);
    const a = await login(app, { email: input.email, password: 'wrong-password' });
    const b = await login(app, { email: 'missing@example.com', password: 'wrong-password' });
    expect(a.statusCode).toBe(401); expect(b.statusCode).toBe(401);
    const { requestId: _, ...first } = a.json().error;
    const { requestId: __, ...second } = b.json().error;
    expect(first).toEqual(second); expect(first.code).toBe('INVALID_CREDENTIALS');
    expect(a.headers['set-cookie']).toBeUndefined();
    if (pool) expect((await pool.query('SELECT count(*) FROM sessions')).rows[0].count).toBe('0');
  });
  it('rejects unknown/body/query fields and invalid types', async () => {
    for (const payload of [{ ...input, userId: user.id }, { ...input, email: null }, { ...input, fullName: 123 }, {}]) {
      const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload });
      expect(result.statusCode).toBe(422); expect(result.json().error.fields.length).toBeGreaterThan(0);
    }
    expect((await app.inject('/api/v1/auth/me?extra=true')).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers, payload: {} })).statusCode).toBe(422);
  });
  it('rejects missing/foreign origins, malformed JSON, non-JSON and oversized body', async () => {
    for (const origin of [undefined, 'https://evil.example']) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: origin ? { origin } : {} })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...headers, 'content-type': 'text/plain' }, payload: 'text' })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: 'a'.repeat(17000) } })).statusCode).toBe(413);
  });
  it('sets request ID and no-store on errors, handles not found and CORS preflight', async () => {
    const response = await app.inject('/missing');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.requestId).toBe(response.headers['x-request-id']);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error.fields).toEqual([]);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: { origin, 'access-control-request-method': 'POST' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    const foreign = await app.inject({ url: '/api/v1/auth/me', headers: { origin: 'https://evil.example' } });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('limits login attempts per IP independently of email and limits general requests', async () => {
    for (let i = 0; i < 20; i++) await login(app, { email: `missing${i}@example.com`, password: input.password });
    const limited = await login(app, { email: 'another@example.com', password: input.password });
    expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBeDefined();
    for (let i = 0; i < 120; i++) await app.inject('/api/v1/auth/me');
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(429);
  });
  it('does not issue a cookie when session persistence fails', async () => {
    await register(app);
    vi.spyOn(repository, 'createSession').mockRejectedValueOnce(new Error('database unavailable'));
    const response = await login(app);
    expect(response.statusCode).toBe(500);
    expect(response.headers['set-cookie']).toBeUndefined();
    if (pool) expect((await pool.query('SELECT count(*) FROM sessions')).rows[0].count).toBe('0');
  });
  it('applies register IP and login email rate limits with retry-after', async () => {
    for (let i = 0; i < 5; i++) await register(app);
    const limited = await register(app);
    expect(limited.statusCode).toBe(429); expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    for (let i = 0; i < 10; i++) await login(app);
    const emailLimit = await login(app);
    expect(emailLimit.statusCode).toBe(429); expect(emailLimit.headers['retry-after']).toBe('900');
    now = new Date(now.getTime() + 900000);
    expect((await login(app)).statusCode).toBe(200);
  });
  it('sets production cookie flags and masks repository failures', async () => {
    await app.close();
    const productionHeaders = { origin: 'https://app.example.com' };
    app = await buildApp({ repository, frontendOrigin: productionHeaders.origin, production: true, clock: () => now, logger: true });
    await app.inject({ method:'POST',url:'/api/v1/auth/register',headers:productionHeaders,payload:input });
    const response = await app.inject({method:'POST',url:'/api/v1/auth/login',headers:productionHeaders,payload:{email:input.email,password:input.password}});
    expect(response.cookies[0].name).toBe('__Host-booking_session');
    expect(response.headers['set-cookie']).toContain('Secure');
    vi.spyOn(repository, 'findUser').mockRejectedValueOnce(new Error('SQL secret password'));
    const failure = await app.inject({method:'POST',url:'/api/v1/auth/login',headers:productionHeaders,payload:{email:input.email,password:input.password}});
    expect(failure.statusCode).toBe(500); expect(failure.json().error.code).toBe('INTERNAL_ERROR');
    expect(failure.body).not.toContain('SQL secret');
  });
});

describe('validation boundaries', () => {
  it.each([12, 128])('accepts password with %i Unicode code points', count => {
    expect(validate(loginSchema, { email: input.email, password: '😀'.repeat(count) }).password).toBe('😀'.repeat(count));
  });
  it.each([11, 129])('rejects password with %i code points', count => {
    expect(() => validate(loginSchema, { email: input.email, password: '😀'.repeat(count) })).toThrow();
  });
  it.each([1, 150])('accepts name with %i characters', count => {
    expect(validate(registerSchema, { ...input, fullName: 'ก'.repeat(count) }).fullName).toHaveLength(count);
  });
  it.each(['', '   ', 'ก'.repeat(151)])('rejects invalid name', fullName => {
    expect(() => validate(registerSchema, { ...input, fullName })).toThrow();
  });
  it.each(['bad', 'a'.repeat(255) + '@example.com'])('rejects invalid email', email => {
    expect(() => validate(registerSchema, { ...input, email })).toThrow();
  });
});

describe('service error boundaries', () => {
  it('uses real clock by default and only recognizes the intended unique constraint', async () => {
    const repository = new MemoryRepository();
    const hasher = { hash: vi.fn().mockResolvedValue('hash'), verify: vi.fn().mockResolvedValue(true) };
    const service = new AuthService(repository, hasher, 'dummy');
    await service.register(input);
    const before = Date.now();
    const result = await service.login(input);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_MS);
    expect((await service.me(result.token)).user.email).toBe(input.email);
    const error = new Error('connection unavailable');
    vi.spyOn(repository, 'createUser').mockRejectedValue(error);
    await expect(service.register(input)).rejects.toBe(error);
  });
  it('rethrows unexpected database conflicts instead of calling every error duplicate email', async () => {
    const repository = new MemoryRepository();
    const hasher = { hash: vi.fn().mockResolvedValue('hash'), verify: vi.fn().mockResolvedValue(true) };
    const service = new AuthService(repository, hasher, 'dummy');
    const error = { code: '23505', constraint: 'unrelated' };
    vi.spyOn(repository, 'createUser').mockRejectedValue(error);
    await expect(service.register(input)).rejects.toBe(error);
    expect(hasher.hash).toHaveBeenCalledWith(input.password);
    await expect(service.logout()).resolves.toBeUndefined();
  });
});

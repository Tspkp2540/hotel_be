import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { buildTestApp as buildApp } from './support/contract-app.js';
import { ApiError } from '../src/errors.js';
import { PgAuthRepository, type AuthRepository } from '../src/auth/repository.js';
import { tokenHash } from '../src/auth/service.js';
import { PgCalendarRepository, type CalendarRepository } from '../src/calendar/repository.js';
import {
  PgBookingRepository,
  type BookingRepository,
  type Booking,
} from '../src/booking/repository.js';
import { BookingService } from '../src/booking/service.js';
import { createBookingSchema, type CreateBooking } from '../src/booking/validation.js';
import { validate } from '../src/auth/validation.js';

const roomId = '7c71298a-ef46-457c-ab5e-9edb238a54e5';
const secondRoom = '20000000-0000-4000-8000-000000000001';
const userA = '10000000-0000-4000-8000-000000000001';
const userB = '10000000-0000-4000-8000-000000000002';
const missingId = '90000000-0000-4000-8000-000000000001';
const tokenA = 'a'.repeat(43),
  tokenB = 'b'.repeat(43),
  tokenA2 = 'c'.repeat(43);
const headers = { origin: 'http://localhost:3000' };
const input: CreateBooking = {
  roomId,
  checkIn: '2026-11-10',
  checkOut: '2026-11-12',
  guestName: 'Guest Person',
  guestPhone: '+66812345678',
  guestEmail: 'guest@example.com',
};
const hasher = { hash: async () => 'unused', verify: async () => false };

class MemoryBooking implements BookingRepository, CalendarRepository {
  async cancel(userId: string, id: string, today: string) {
    const booking = this.bookings.find(b => b.id === id && b.userId === userId);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', 'missing');
    if (booking.status !== 'cancelled' && booking.checkIn <= today)
      throw new ApiError(409, 'CANCELLATION_NOT_ALLOWED', 'late');
    booking.status = 'cancelled';
    for (const [key, record] of this.requests)
      if (record.id === id) this.requests.set(key, booking);
    return booking;
  }
  async listForUser(userId: string, limit: number, cursor?: string) {
    const rows = this.bookings
      .filter(b => b.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const index = cursor ? rows.findIndex(b => b.id === cursor) : -1;
    if (cursor && index < 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid cursor');
    const bookings = rows.slice(index + 1, index + 1 + limit).map(({ userId: _owner, ...b }) => ({
      ...b,
      roomName: b.roomId === roomId ? 'Main' : 'Second',
    }));
    return {
      bookings,
      nextCursor: rows.length > index + 1 + limit ? bookings[bookings.length - 1].id : null,
    };
  }
  requests = new Map<string, Booking>();
  async findByRequest(userId: string, key: string) {
    return this.requests.get(`${userId}:${key}`) ?? null;
  }
  rooms = new Map([
    [roomId, true],
    [secondRoom, true],
  ]);
  bookings: Array<Booking & { userId: string }> = [];
  async create(userId: string, data: CreateBooking, key?: string): Promise<Booking> {
    if (!this.rooms.has(data.roomId)) throw new ApiError(404, 'ROOM_NOT_FOUND', 'missing');
    if (!this.rooms.get(data.roomId)) throw new ApiError(409, 'ROOM_UNAVAILABLE', 'closed');
    if (
      this.bookings.some(
        b =>
          b.status === 'confirmed' &&
          b.roomId === data.roomId &&
          b.checkIn < data.checkOut &&
          b.checkOut > data.checkIn,
      )
    )
      throw { code: '23P01', constraint: 'prevent_overlapping_bookings' };
    const booking: Booking = {
      ...data,
      id: randomUUID(),
      nights: (Date.parse(data.checkOut) - Date.parse(data.checkIn)) / 86400000,
      status: 'confirmed',
      createdAt: '2026-11-06T00:00:00.000Z',
    };
    this.bookings.push({ ...booking, userId });
    if (key) this.requests.set(`${userId}:${key}`, booking);
    return booking;
  }
  async listActiveRooms() {
    return [];
  }
  async isRoomActive(id: string) {
    return this.rooms.get(id) === true;
  }
  async bookedRanges(id: string, from: string, to: string) {
    return this.bookings
      .filter(b => b.roomId === id && b.checkIn < to && b.checkOut > from)
      .map(({ checkIn, checkOut }) => ({ checkIn, checkOut }));
  }
}

describe('Booking API (memory or actual PostgreSQL)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>,
    pool: Pool | undefined,
    repository: BookingRepository,
    memory: MemoryBooking,
    now: Date;
  let auth: AuthRepository, calendar: CalendarRepository;
  beforeEach(async () => {
    now = new Date('2026-11-05T17:00:00Z');
    if (process.env.TEST_DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        application_name: 'booking-api-test',
      });
      await pool.query('TRUNCATE bookings,sessions,users,rooms CASCADE');
      await pool.query(
        "INSERT INTO users(id,email,password_hash,full_name) VALUES ($1,'owner-a@example.com','fixture','Owner A'),($2,'owner-b@example.com','fixture','Owner B')",
        [userA, userB],
      );
      for (const [id, token] of [
        [userA, tokenA],
        [userB, tokenB],
        [userA, tokenA2],
      ])
        await pool.query(
          "INSERT INTO sessions(user_id,token_hash,created_at,expires_at) VALUES($1,$2,'2026-11-01T00:00:00Z','2026-11-08T00:00:00Z')",
          [id, tokenHash(token)],
        );
      await pool.query(
        "INSERT INTO rooms(id,name,hotel_id) VALUES($1,'Main','80000000-0000-4000-8000-000000000001'),($2,'Second','80000000-0000-4000-8000-000000000001')",
        [roomId, secondRoom],
      );
      repository = new PgBookingRepository(pool);
      calendar = new PgCalendarRepository(pool);
      auth = new PgAuthRepository(pool);
    } else {
      memory = new MemoryBooking();
      repository = memory;
      calendar = memory;
      auth = {
        createUser: vi.fn(),
        findUser: vi.fn(),
        createSession: vi.fn(),
        deleteSession: vi.fn(),
        findSession: async hash => {
          const id =
            hash === tokenHash(tokenB)
              ? userB
              : [tokenHash(tokenA), tokenHash(tokenA2)].includes(hash)
                ? userA
                : undefined;
          return id
            ? {
                user: {
                  id,
                  email: 'owner@example.com',
                  fullName: 'Owner',
                  createdAt: '2026-11-01T00:00:00Z',
                },
                expiresAt: new Date('2026-11-08T00:00:00Z'),
              }
            : undefined;
        },
      };
    }
    app = await buildApp({
      repository: auth,
      calendarRepository: calendar,
      bookingRepository: repository,
      frontendOrigin: headers.origin,
      clock: () => now,
      hasher,
    });
  });
  afterEach(async () => {
    await app.close();
    await pool?.end();
  });
  const post = (
    payload: unknown = input,
    token: string | undefined = tokenA,
    url = '/api/v1/bookings',
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers,
      payload: payload as object,
      cookies: token ? { booking_session: token } : undefined,
    });
  async function count() {
    return pool
      ? Number((await pool.query('SELECT count(*) FROM bookings')).rows[0].count)
      : memory.bookings.length;
  }
  const key = 'abcdef00-0000-4000-8000-000000000001';
  const keyed = (payload: unknown = input, requestKey = key, token = tokenA) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { ...headers, 'idempotency-key': requestKey },
      payload: payload as object,
      cookies: { booking_session: token },
    });
  const lookup = (requestKey = key, token: string | undefined = tokenA, query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/bookings/requests/${requestKey}${query}`,
      cookies: token ? { booking_session: token } : undefined,
    });

  const cancel = (id: string, token = tokenA, extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/bookings/' + id + '/cancel',
      headers,
      cookies: token ? { booking_session: token } : undefined,
      ...extra,
    });
  const list = (query = '', token = tokenA) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/bookings' + query,
      cookies: token ? { booking_session: token } : undefined,
    });
  it('cancels only an owned booking, keeps history and releases dates', async () => {
    const original = (await keyed()).json().data.booking;
    expect((await cancel(original.id, tokenB)).statusCode).toBe(404);
    expect((await cancel(missingId)).json().error.code).toBe('BOOKING_NOT_FOUND');
    expect((await cancel(original.id, '')).statusCode).toBe(401);
    const result = await cancel(original.id);
    expect(result.statusCode).toBe(200);
    expect(result.json().data.booking).toEqual({ ...original, status: 'cancelled' });
    const before = pool
      ? (
          await pool.query('SELECT cancelled_at,updated_at FROM bookings WHERE id=$1', [
            original.id,
          ])
        ).rows[0]
      : null;
    expect((await cancel(original.id)).json()).toEqual(result.json());
    if (pool)
      expect(
        (
          await pool.query('SELECT cancelled_at,updated_at FROM bookings WHERE id=$1', [
            original.id,
          ])
        ).rows[0],
      ).toEqual(before);
    expect((await lookup()).json().data.booking.status).toBe('cancelled');
    expect((await keyed()).json().data.booking.status).toBe('cancelled');
    expect((await post(input, tokenB)).statusCode).toBe(201);
    expect(await count()).toBe(2);
    expect(
      (
        await new BookingService(repository, () => new Date('2026-11-11T00:00:00Z')).cancel(
          userA,
          original.id,
        )
      ).status,
    ).toBe('cancelled');
  });
  it('uses Bangkok midnight as the cancellation boundary', async () => {
    const original = (
      await post({ ...input, checkIn: '2026-11-07', checkOut: '2026-11-08' })
    ).json().data.booking;
    now = new Date('2026-11-06T16:59:59.999Z');
    expect((await cancel(original.id)).statusCode).toBe(200);
    const another = (
      await post({ ...input, roomId: secondRoom, checkIn: '2026-11-07', checkOut: '2026-11-08' })
    ).json().data.booking;
    now = new Date('2026-11-06T17:00:00.000Z');
    expect((await cancel(another.id)).json().error.code).toBe('CANCELLATION_NOT_ALLOWED');
  });
  it('rejects invalid cancellation shapes and cross-site requests without changing status', async () => {
    const original = (await post()).json().data.booking;
    expect((await cancel('invalid')).statusCode).toBe(422);
    expect((await cancel(original.id, tokenA, { payload: {} })).statusCode).toBe(422);
    expect(
      (
        await cancel(original.id, tokenA, {
          url: '/api/v1/bookings/' + original.id + '/cancel?userId=' + userB,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await cancel(original.id, tokenA, { headers: { origin: 'https://foreign.example' } }))
        .statusCode,
    ).toBe(403);
    expect((await list()).json().data.bookings[0].status).toBe('confirmed');
  });
  it('limits cancellation across sessions and handles concurrent retries', async () => {
    const original = (await post()).json().data.booking;
    const results = await Promise.all([cancel(original.id), cancel(original.id, tokenA2)]);
    expect(results.map(r => r.statusCode)).toEqual([200, 200]);
    for (let i = 0; i < 8; i++) expect((await cancel(original.id)).statusCode).toBe(200);
    const limited = await cancel(original.id, tokenA2);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
  });
  it('does not expose raw persistence errors', async () => {
    vi.spyOn(repository, 'cancel').mockRejectedValue(
      new Error('SELECT secret FROM database; password=private'),
    );
    const response = await cancel(missingId);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toMatch(/SELECT|private|stack|password/);
  });
  it('filters unexpected internal booking fields at all response boundaries', async () => {
    const secret = {
      userId: userB,
      requestKey: key,
      passwordHash: 'private-hash',
      sql: 'private-sql',
    };
    const record = {
      ...input,
      id: missingId,
      nights: 2,
      status: 'confirmed' as const,
      createdAt: '2026-11-06T00:00:00.000Z',
      ...secret,
    };
    vi.spyOn(repository, 'create').mockResolvedValue(record);
    vi.spyOn(repository, 'findByRequest').mockResolvedValue(record);
    vi.spyOn(repository, 'listForUser').mockResolvedValue({
      bookings: [{ ...record, roomName: 'Main' }],
      nextCursor: null,
    });
    vi.spyOn(repository, 'cancel').mockResolvedValue({ ...record, status: 'cancelled' });
    for (const response of [await post(), await lookup(), await list(), await cancel(missingId)]) {
      expect(response.statusCode).toBeLessThan(300);
      const body = response.json().data;
      const booking = body.booking ?? body.bookings[0];
      for (const key of Object.keys(secret)) expect(booking).not.toHaveProperty(key);
    }
  });
  it('requires login, rejects invalid filters and returns an empty owner history', async () => {
    expect((await list('', '')).statusCode).toBe(401);
    expect((await list()).json().data).toEqual({ bookings: [], nextCursor: null });
    for (const query of [
      '?userId=' + userB,
      '?limit=0',
      '?limit=51',
      '?limit=1.5',
      '?limit=01',
      '?cursor=bad',
      '?limit=1&limit=2',
    ])
      expect((await list(query)).statusCode).toBe(422);
  });
  it('paginates only owned bookings without duplicates and rejects foreign cursors', async () => {
    const first = (await post()).json().data.booking;
    const second = (await post({ ...input, checkIn: '2026-11-12', checkOut: '2026-11-14' })).json()
      .data.booking;
    const foreign = (await post({ ...input, roomId: secondRoom }, tokenB)).json().data.booking;
    const all = (await list()).json().data;
    expect(all.bookings).toHaveLength(2);
    expect(new Set(all.bookings.map((b: Booking) => b.id))).toEqual(new Set([first.id, second.id]));
    expect(all.bookings[0].roomName).toBe('Main');
    const page1 = (await list('?limit=1')).json().data;
    expect(page1.nextCursor).toBe(page1.bookings[0].id);
    const page2 = (await list('?limit=1&cursor=' + page1.nextCursor)).json().data;
    expect(page2.nextCursor).toBeNull();
    expect(page2.bookings[0].id).not.toBe(page1.bookings[0].id);
    expect((await list('?cursor=' + foreign.id)).statusCode).toBe(422);
    expect((await list('?cursor=' + missingId)).statusCode).toBe(422);
    expect((await list('', tokenB)).json().data.bookings.map((b: Booking) => b.id)).toEqual([
      foreign.id,
    ]);
    if (pool) {
      await pool.query("UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1", [
        first.id,
      ]);
      await pool.query('UPDATE rooms SET is_active=false WHERE id=$1', [roomId]);
      expect(
        (await list()).json().data.bookings.find((b: Booking) => b.id === first.id).status,
      ).toBe('cancelled');
    }
  });
  it('replays normalized requests across sessions without creating another booking', async () => {
    const first = await keyed();
    const replay = await keyed(
      {
        ...input,
        roomId: roomId.toUpperCase(),
        guestName: ' Guest Person ',
        guestEmail: 'GUEST@example.com',
      },
      key.toUpperCase(),
      tokenA2,
    );
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(await count()).toBe(1);
    expect((await lookup()).json()).toEqual(first.json());
  });
  it('rejects reuse with different data and keeps the original result', async () => {
    const first = await keyed();
    const changed = await keyed({ ...input, guestPhone: '+66899999999' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await lookup()).json()).toEqual(first.json());
    expect(await count()).toBe(1);
  });
  it('scopes keys and lookup to the authenticated owner', async () => {
    await keyed();
    expect((await lookup(key, tokenB)).statusCode).toBe(404);
    expect((await lookup(key, '')).statusCode).toBe(401);
    const other = await keyed({ ...input, roomId: secondRoom }, key, tokenB);
    expect(other.statusCode).toBe(201);
    expect(await count()).toBe(2);
    expect((await lookup(key, tokenB)).json().data.booking.roomId).toBe(secondRoom);
  });
  it('validates key headers, lookup params and unknown query fields', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/bookings',
      headers: {
        ...headers,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('idempotency-key');
    expect((await keyed(input, 'bad')).statusCode).toBe(422);
    expect((await lookup('bad')).statusCode).toBe(422);
    expect((await lookup(key, tokenA, '?extra=1')).statusCode).toBe(422);
    const missing = await lookup();
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('BOOKING_REQUEST_NOT_FOUND');
    expect(await count()).toBe(0);
  });
  it('does not reserve the key for failed requests', async () => {
    expect((await keyed({ ...input, checkOut: input.checkIn })).statusCode).toBe(422);
    expect((await lookup()).statusCode).toBe(404);
    expect((await keyed()).statusCode).toBe(201);
  });
  it('rolls back the key on conflict and permits a corrected request', async () => {
    expect((await post()).statusCode).toBe(201);
    expect((await keyed()).statusCode).toBe(409);
    expect((await lookup()).statusCode).toBe(404);
    expect((await keyed({ ...input, roomId: secondRoom })).statusCode).toBe(201);
    expect(await count()).toBe(2);
  });
  it('replays a committed request after room closure', async () => {
    const first = await keyed();
    if (pool) await pool.query('UPDATE rooms SET is_active=false WHERE id=$1', [roomId]);
    else memory.rooms.set(roomId, false);
    expect((await keyed()).json()).toEqual(first.json());
  });
  it.runIf(!!process.env.TEST_DATABASE_URL)(
    'returns a cancelled stored result without creating a replacement',
    async () => {
      await keyed();
      await pool!.query(
        "UPDATE bookings SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE request_key=$1",
        [key],
      );
      expect((await lookup()).json().data.booking.status).toBe('cancelled');
      expect((await keyed()).json().data.booking.status).toBe('cancelled');
      expect(await count()).toBe(1);
    },
  );
  it.runIf(!!process.env.TEST_DATABASE_URL)(
    'rolls back simultaneous same-key different-payload replay',
    async () => {
      const results = await Promise.allSettled([
        repository.create(userA, input, key),
        repository.create(userA, { ...input, guestPhone: '+66899999999' }, key),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await count()).toBe(1);
    },
  );
  it.runIf(!!process.env.TEST_DATABASE_URL)(
    'serializes simultaneous identical keys across transactions',
    async () => {
      const gate = await pool!.connect();
      let pending: Array<PromiseLike<unknown>> = [];
      try {
        await gate.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`${userA}:${key}`]);
        const a = Promise.resolve(keyed()),
          b = Promise.resolve(keyed());
        pending = [a, b];
        await waitFor(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='booking-api-test' AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'",
          2,
        );
        await gate.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`${userA}:${key}`]);
        const results = await Promise.all([a, b]);
        expect(results.map(r => r.statusCode)).toEqual([201, 201]);
        expect(results[0].json()).toEqual(results[1].json());
        expect(await count()).toBe(1);
      } finally {
        await gate.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`${userA}:${key}`]);
        gate.release();
        await Promise.all(pending);
      }
    },
    15000,
  );

  it('creates with exact public response, normalized guests, session ownership and calendar read-after-write', async () => {
    const response = await post({
      ...input,
      guestName: ' Guest Person ',
      guestEmail: ' GUEST@example.com ',
      guestPhone: ' +66812345678 ',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        booking: {
          ...input,
          id: expect.any(String),
          nights: 2,
          status: 'confirmed',
          createdAt: expect.any(String),
        },
      },
    });
    expect(await count()).toBe(1);
    if (pool) {
      const row = (
        await pool.query(
          'SELECT user_id,guest_name,guest_email,guest_phone,status,cancelled_at FROM bookings',
        )
      ).rows[0];
      expect(row).toEqual({
        user_id: userA,
        guest_name: input.guestName,
        guest_email: input.guestEmail,
        guest_phone: input.guestPhone,
        status: 'confirmed',
        cancelled_at: null,
      });
    } else expect(memory.bookings[0].userId).toBe(userA);
    const calendarResponse = await app.inject({
      url: `/api/v1/rooms/${roomId}/calendar?from=2026-11-01&to=2026-12-01`,
      cookies: { booking_session: tokenB },
    });
    expect(calendarResponse.json().data.bookedRanges).toEqual([
      { checkIn: input.checkIn, checkOut: input.checkOut },
    ]);
    expect(calendarResponse.body).not.toContain(input.guestEmail);
  });
  it('requires a valid unexpired session and adds no bookings', async () => {
    for (const token of ['', 'bad', 'd'.repeat(43)])
      expect((await post(input, token)).statusCode).toBe(401);
    now = new Date('2026-11-08T00:00:00Z');
    expect((await post()).statusCode).toBe(401);
    expect(await count()).toBe(0);
  });
  it('rejects NUL in guestName without creating a booking', async () => {
    const create = vi.spyOn(repository, 'create');
    const response = await post({ ...input, guestName: 'Guest\u0000Name' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'guestName', code: 'INVALID_FORMAT' }),
      ]),
    );
    expect(create).not.toHaveBeenCalled();
    expect(await count()).toBe(0);
  });
  it('returns room missing/inactive errors and rolls back', async () => {
    expect((await post({ ...input, roomId: missingId })).json().error.code).toBe('ROOM_NOT_FOUND');
    if (pool) await pool.query('UPDATE rooms SET is_active=false WHERE id=$1', [roomId]);
    else memory.rooms.set(roomId, false);
    const closed = await post();
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('ROOM_UNAVAILABLE');
    expect(await count()).toBe(0);
  });
  it.each([
    ['2026-11-05', '2026-11-07', 'DATE_IN_PAST'],
    ['2027-11-07', '2027-11-08', 'TOO_FAR_IN_ADVANCE'],
    ['2026-11-10', '2026-11-10', 'MUST_BE_AFTER_CHECK_IN'],
    ['2026-11-10', '2026-11-09', 'MUST_BE_AFTER_CHECK_IN'],
    ['2026-11-06', '2026-12-07', 'MAX_NIGHTS_EXCEEDED'],
  ])('rejects date rule %s / %s with %s and no row', async (checkIn, checkOut, code) => {
    const response = await post({ ...input, checkIn, checkOut });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    expect(await count()).toBe(0);
  });
  it.each([
    ['2026-11-06', '2026-11-07', 1],
    ['2026-11-06', '2026-12-06', 30],
    ['2027-11-06', '2027-11-07', 1],
    ['2026-12-31', '2027-01-02', 2],
  ])('accepts date boundary %s / %s', async (checkIn, checkOut, nights) => {
    const response = await post({ ...input, checkIn, checkOut });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.booking.nights).toBe(nights);
  });
  it.each([
    { guestPhone: '0812345678' },
    { guestPhone: '+012345' },
    { guestPhone: '+1234567890123456' },
    { guestPhone: '+66abc' },
    { guestName: '' },
    { guestName: 'x'.repeat(151) },
    { guestEmail: 'bad' },
    { guestEmail: null },
    { roomId: 'bad' },
    { checkIn: '2026-02-30' },
    { checkOut: '2026-11-12T00:00:00Z' },
    { guestPhone: 123 },
    { userId: userB },
    { status: 'cancelled' },
    { extra: true },
  ])('rejects invalid body %j without writes', async change => {
    expect((await post({ ...input, ...change })).statusCode).toBe(422);
    expect(await count()).toBe(0);
  });
  it('rejects missing fields and unknown query without writes', async () => {
    expect((await post({})).statusCode).toBe(422);
    expect((await post(input, tokenA, '/api/v1/bookings?extra=true')).statusCode).toBe(422);
    expect(await count()).toBe(0);
  });
  it('duplicate request conflicts and preserves the first booking exactly', async () => {
    const first = (await post()).json().data.booking;
    const second = await post();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('BOOKING_CONFLICT');
    expect(await count()).toBe(1);
    if (pool) expect((await pool.query('SELECT id FROM bookings')).rows[0].id).toBe(first.id);
    else expect(memory.bookings[0].id).toBe(first.id);
  });
  it('rejects partial overlap, containing and contained intervals across users', async () => {
    await post();
    for (const [checkIn, checkOut] of [
      ['2026-11-09', '2026-11-11'],
      ['2026-11-11', '2026-11-13'],
      ['2026-11-09', '2026-11-13'],
      ['2026-11-10', '2026-11-11'],
    ]) {
      const response = await post({ ...input, checkIn, checkOut }, tokenB);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('BOOKING_CONFLICT');
    }
    expect(await count()).toBe(1);
  });
  it('allows adjacent bookings on both sides and same dates in a different room', async () => {
    await post();
    for (const change of [
      { checkIn: '2026-11-08', checkOut: '2026-11-10' },
      { checkIn: '2026-11-12', checkOut: '2026-11-14' },
      { roomId: secondRoom },
    ])
      expect((await post({ ...input, ...change }, tokenB)).statusCode).toBe(201);
    expect(await count()).toBe(4);
  });
  it('applies per-user limit across sessions, separates users, and resets the window', async () => {
    for (let i = 0; i < 10; i++) await post({});
    const limited = await post(input, tokenA2);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(await count()).toBe(0);
    expect((await post(input, tokenB)).statusCode).toBe(201);
    now = new Date(now.getTime() + 60000);
    expect((await post({ ...input, roomId: secondRoom })).statusCode).toBe(201);
  });
  it('uses identical custom rules for calendar metadata and booking validation', async () => {
    await app.close();
    app = await buildApp({
      repository: auth,
      calendarRepository: calendar,
      bookingRepository: repository,
      frontendOrigin: headers.origin,
      clock: () => now,
      hasher,
      bookingRules: { maxNights: 2, maxAdvanceDays: 5 },
    });
    const metadata = await app.inject({
      url: `/api/v1/rooms/${roomId}/calendar?from=2026-11-01&to=2026-12-01`,
      cookies: { booking_session: tokenA },
    });
    expect(metadata.json().data.bookingRules).toEqual({ maxNights: 2, maxAdvanceDays: 5 });
    expect(
      (await post({ ...input, checkIn: '2026-11-11', checkOut: '2026-11-13' })).statusCode,
    ).toBe(201);
    expect(
      (await post({ ...input, checkIn: '2026-11-12', checkOut: '2026-11-13' })).json().error
        .fields[0].code,
    ).toBe('TOO_FAR_IN_ADVANCE');
    expect(
      (await post({ ...input, checkIn: '2026-11-06', checkOut: '2026-11-09' })).json().error
        .fields[0].code,
    ).toBe('MAX_NIGHTS_EXCEEDED');
  });
  it('does not expose infrastructure failures as booking conflicts', async () => {
    vi.spyOn(repository, 'create').mockRejectedValueOnce(new Error('SQL private@example.com'));
    const response = await post();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toMatch(/SQL|private@example/);
    expect(await count()).toBe(0);
  });

  const integration = process.env.TEST_DATABASE_URL ? it : it.skip;
  async function waitFor(query: string, minimum = 1) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (Number((await pool!.query(query)).rows[0].count) >= minimum) return;
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error('Expected PostgreSQL lock state was not reached');
  }
  integration.each([false, true])(
    'real overlapping API requests: first transaction forced rollback=%s',
    async forceRollback => {
      // A is held AFTER INSERT so its uncommitted exclusion entry blocks B for real.
      const gate = await pool!.connect();
      let pending: Array<Promise<Awaited<ReturnType<typeof app.inject>>>> = [];
      try {
        await pool!
          .query(`CREATE FUNCTION booking_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.user_id='${userA}'::uuid THEN
          PERFORM pg_advisory_xact_lock(7854123);
          ${forceRollback ? "RAISE EXCEPTION 'forced test rollback';" : ''}
        END IF; RETURN NEW; END $$;
        CREATE TRIGGER booking_test_gate AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION booking_test_gate();`);
        await gate.query('SELECT pg_advisory_lock(7854123)');
        const first = Promise.resolve(post());
        pending.push(first);
        await waitFor(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='booking-api-test' AND wait_event='advisory'",
        );
        const second = Promise.resolve(post(input, tokenB));
        pending.push(second);
        await waitFor(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='booking-api-test' AND wait_event='transactionid'",
        );
        await gate.query('SELECT pg_advisory_unlock(7854123)');
        const [a, b] = await Promise.all(pending);
        expect(a.statusCode).toBe(forceRollback ? 500 : 201);
        expect(b.statusCode).toBe(forceRollback ? 201 : 409);
        if (!forceRollback) expect(b.json().error.code).toBe('BOOKING_CONFLICT');
        expect(await count()).toBe(1);
        expect((await pool!.query('SELECT user_id FROM bookings')).rows[0].user_id).toBe(
          forceRollback ? userB : userA,
        );
        // A failed transaction must not poison a pooled connection.
        expect((await post({ ...input, roomId: secondRoom }, tokenB)).statusCode).toBe(201);
      } finally {
        await gate.query('SELECT pg_advisory_unlock(7854123)');
        gate.release();
        await Promise.all(pending);
        await pool!.query(
          'DROP TRIGGER IF EXISTS booking_test_gate ON bookings; DROP FUNCTION IF EXISTS booking_test_gate();',
        );
      }
    },
    15000,
  );
  integration('concurrent non-overlapping intervals both succeed', async () => {
    const responses = await Promise.all([
      post(),
      post({ ...input, checkIn: '2026-11-12', checkOut: '2026-11-14' }, tokenB),
    ]);
    expect(responses.map(r => r.statusCode)).toEqual([201, 201]);
    expect(await count()).toBe(2);
  });
  integration('concurrent same dates in different rooms both succeed', async () => {
    const responses = await Promise.all([post(), post({ ...input, roomId: secondRoom }, tokenB)]);
    expect(responses.map(r => r.statusCode)).toEqual([201, 201]);
    expect(await count()).toBe(2);
  });
  integration(
    'closing a room while booking waits yields unavailable, without inserts',
    async () => {
      const closer = await pool!.connect();
      let pending: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
      try {
        await closer.query('BEGIN');
        await closer.query(
          'UPDATE rooms SET is_active=false,updated_at=CURRENT_TIMESTAMP WHERE id=$1',
          [roomId],
        );
        pending = Promise.resolve(post());
        await waitFor(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='booking-api-test' AND wait_event_type='Lock' AND query LIKE 'SELECT is_active%'",
        );
        await closer.query('COMMIT');
        const response = await pending;
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('ROOM_UNAVAILABLE');
        expect(await count()).toBe(0);
      } finally {
        await closer.query('ROLLBACK');
        closer.release();
        await pending;
      }
    },
    15000,
  );
});

describe('Booking validation and service boundaries', () => {
  it.each(['+12', '+123456789012345'])('accepts boundary phone %s', guestPhone => {
    expect(validate(createBookingSchema, { ...input, guestPhone }).guestPhone).toBe(guestPhone);
  });
  it('uses real clock by default and rejects unrelated errors unchanged', async () => {
    const repository = new MemoryBooking();
    const service = new BookingService(repository);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
    expect(
      (await service.create(userA, { ...input, checkIn: today, checkOut: tomorrow })).nights,
    ).toBe(1);
    const error = { code: '23P01', constraint: 'another_constraint' };
    vi.spyOn(repository, 'create').mockRejectedValue(error);
    await expect(
      service.create(userA, { ...input, checkIn: today, checkOut: tomorrow }),
    ).rejects.toBe(error);
  });
  it('does not call persistence when business validation fails', async () => {
    const repository = {
      create: vi.fn(),
      findByRequest: vi.fn(),
      listForUser: vi.fn(),
      cancel: vi.fn(),
    };
    const service = new BookingService(repository, () => new Date('2026-11-05T17:00:00Z'));
    await expect(service.create(userA, { ...input, checkIn: '2026-11-05' })).rejects.toMatchObject({
      status: 422,
    });
    expect(repository.create).not.toHaveBeenCalled();
  });
  it('returns all applicable field errors', async () => {
    const service = new BookingService(new MemoryBooking(), () => new Date('2026-11-05T17:00:00Z'));
    await expect(
      service.create(userA, { ...input, checkIn: '2026-11-05', checkOut: '2026-12-10' }),
    ).rejects.toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ code: 'DATE_IN_PAST' }),
        expect.objectContaining({ code: 'MAX_NIGHTS_EXCEEDED' }),
      ]),
    });
  });
});

describe('PgBookingRepository failure cleanup', () => {
  it.each(['connect', 'BEGIN', 'INSERT', 'COMMIT', 'ROLLBACK'])(
    'handles failure at %s without returning a successful booking',
    async stage => {
      const failure = new Error(`failure-${stage}`);
      const query = vi.fn(async (sql: string) => {
        if (
          sql === stage ||
          (stage === 'INSERT' && sql.includes('INSERT INTO')) ||
          (stage === 'ROLLBACK' && (sql.includes('INSERT INTO') || sql === 'ROLLBACK'))
        )
          throw failure;
        if (sql.startsWith('SELECT')) return { rows: [{ is_active: true }] };
        return { rows: [] };
      });
      const release = vi.fn();
      const client = { query, release } as unknown as PoolClient;
      const pool = {
        connect:
          stage === 'connect'
            ? vi.fn().mockRejectedValue(failure)
            : vi.fn().mockResolvedValue(client),
      } as unknown as Pool;
      await expect(new PgBookingRepository(pool).create(userA, input)).rejects.toBe(failure);
      if (stage === 'connect') expect(release).not.toHaveBeenCalled();
      else {
        expect(query).toHaveBeenCalledWith('ROLLBACK');
        expect(release).toHaveBeenCalledWith(stage === 'ROLLBACK');
      }
    },
  );
});

describe('Idempotent booking service', () => {
  it('replays a committed request after the check-in date has passed', async () => {
    const repository = new MemoryBooking();
    const original = await new BookingService(
      repository,
      () => new Date('2026-11-06T00:00:00Z'),
    ).create(userA, input, '30000000-0000-4000-8000-000000000001');
    expect(
      await new BookingService(repository, () => new Date('2027-01-01T00:00:00Z')).create(
        userA,
        input,
        '30000000-0000-4000-8000-000000000001',
      ),
    ).toEqual(original);
  });
});

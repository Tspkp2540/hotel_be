import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { buildTestApp as buildApp } from './support/contract-app.js';
import { tokenHash } from '../src/auth/service.js';
import { PgAuthRepository, type AuthRepository } from '../src/auth/repository.js';
import {
  PgCalendarRepository,
  type CalendarRepository,
  type BookedRange,
} from '../src/calendar/repository.js';
import { CalendarService } from '../src/calendar/service.js';
import { bangkokToday, calendarQuery, localDate } from '../src/calendar/dates.js';
import { validate } from '../src/auth/validation.js';

const roomId = '7c71298a-ef46-457c-ab5e-9edb238a54e5';
const otherId = '20000000-0000-4000-8000-000000000001';
const inactiveId = '30000000-0000-4000-8000-000000000001';
const missingId = '40000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(43);
const cookies = { booking_session: token };
const publicUser = {
  id: userId,
  email: 'private@example.com',
  fullName: 'Private Guest',
  createdAt: '2026-11-01T00:00:00.000Z',
};
const hasher = { hash: async () => 'unused-fixture', verify: async () => false };

class MemoryCalendar implements CalendarRepository {
  rooms = [
    { id: otherId, name: 'Second room', hotelName: 'บ้านพักเชียงใหม่', province: 'เชียงใหม่' },
    { id: roomId, name: 'บ้านพักหลัก', hotelName: 'บ้านพักเชียงใหม่', province: 'เชียงใหม่' },
  ];
  bookings: Array<BookedRange & { roomId: string; status: string }> = [];
  async listActiveRooms() {
    return this.rooms;
  }
  async isRoomActive(id: string) {
    return this.rooms.some(room => room.id === id);
  }
  async bookedRanges(id: string, from: string, to: string) {
    return this.bookings
      .filter(
        b => b.roomId === id && b.status === 'confirmed' && b.checkIn < to && b.checkOut > from,
      )
      .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
      .map(({ checkIn, checkOut }) => ({ checkIn, checkOut }));
  }
}

describe('Rooms/calendar API contract (memory or PostgreSQL)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool | undefined;
  let repository: CalendarRepository;
  let memory: MemoryCalendar;
  let now: Date;
  const url = (query = 'from=2026-11-01&to=2026-12-01', id = roomId) =>
    `/api/v1/rooms/${id}/calendar?${query}`;
  beforeEach(async () => {
    now = new Date('2026-11-05T17:00:00.000Z');
    let auth: AuthRepository;
    if (process.env.TEST_DATABASE_URL) {
      pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await pool.query('TRUNCATE bookings,sessions,users,rooms CASCADE');
      await pool.query('INSERT INTO users(id,email,password_hash,full_name) VALUES($1,$2,$3,$4)', [
        userId,
        publicUser.email,
        'unused-fixture',
        publicUser.fullName,
      ]);
      await pool.query(
        'INSERT INTO sessions(user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4)',
        [userId, tokenHash(token), '2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z'],
      );
      await pool.query(
        `INSERT INTO rooms(id,name,is_active,created_at,hotel_id) VALUES
        ($1,'บ้านพักหลัก',true,'2026-10-01T00:00:00Z','80000000-0000-4000-8000-000000000001'),
        ($2,'Second room',true,'2026-10-01T00:00:00Z','80000000-0000-4000-8000-000000000001'),
        ($3,'Inactive room',false,'2026-09-01T00:00:00Z','80000000-0000-4000-8000-000000000001')`,
        [roomId, otherId, inactiveId],
      );
      repository = new PgCalendarRepository(pool);
      auth = new PgAuthRepository(pool);
    } else {
      memory = new MemoryCalendar();
      repository = memory;
      auth = {
        createUser: vi.fn(),
        findUser: vi.fn(),
        createSession: vi.fn(),
        deleteSession: vi.fn(),
        findSession: async hash =>
          hash === tokenHash(token)
            ? { user: publicUser, expiresAt: new Date('2026-11-08T00:00:00Z') }
            : undefined,
      };
    }
    app = await buildApp({
      repository: auth,
      calendarRepository: repository,
      frontendOrigin: 'http://localhost:3000',
      clock: () => now,
      hasher,
    });
  });
  afterEach(async () => {
    await app.close();
    await pool?.end();
  });
  async function book(checkIn: string, checkOut: string, id = roomId, status = 'confirmed') {
    if (pool)
      await pool.query(
        `INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email,status,cancelled_at)
      VALUES($1,$2,$3,$4,'Private Guest','+66812345678','private@example.com',$5::booking_status,CASE WHEN $5::booking_status='cancelled' THEN CURRENT_TIMESTAMP END)`,
        [userId, id, checkIn, checkOut, status],
      );
    else memory.bookings.push({ checkIn, checkOut, roomId: id, status });
  }

  it('lists only active rooms in stable created_at/id order with exact public fields', async () => {
    const response = await app.inject({ url: '/api/v1/rooms', cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        rooms: [
          {
            id: otherId,
            name: 'Second room',
            hotelName: 'บ้านพักเชียงใหม่',
            province: 'เชียงใหม่',
          },
          { id: roomId, name: 'บ้านพักหลัก', hotelName: 'บ้านพักเชียงใหม่', province: 'เชียงใหม่' },
        ],
      },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('returns empty rooms if no active rooms exist', async () => {
    if (pool) await pool.query('UPDATE rooms SET is_active=false');
    else memory.rooms = [];
    expect((await app.inject({ url: '/api/v1/rooms', cookies })).json()).toEqual({
      data: { rooms: [] },
    });
  });
  it.each(['/api/v1/rooms', `/api/v1/rooms/${roomId}/calendar?from=2026-11-01&to=2026-12-01`])(
    'requires login for %s',
    async path => {
      for (const value of [undefined, 'bad', 'b'.repeat(43)]) {
        const response = await app.inject({
          url: path,
          cookies: value ? { booking_session: value } : undefined,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHORIZED');
      }
      now = new Date('2026-11-08T00:00:00Z');
      expect((await app.inject({ url: path, cookies })).statusCode).toBe(401);
    },
  );
  it('checks authentication before reporting invalid room/query details', async () => {
    expect((await app.inject(url('extra=true', 'bad'))).statusCode).toBe(401);
  });
  it('returns empty ranges, business rules and today at Bangkok midnight', async () => {
    const response = await app.inject({ url: url(), cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        roomId,
        timezone: 'Asia/Bangkok',
        today: '2026-11-06',
        bookingRules: { maxNights: 30, maxAdvanceDays: 365 },
        from: '2026-11-01',
        to: '2026-12-01',
        bookedRanges: [],
      },
    });
    now = new Date('2026-11-05T16:59:59.999Z');
    expect((await app.inject({ url: url(), cookies })).json().data.today).toBe('2026-11-05');
  });
  it('returns sorted actual ranges inside and across both query boundaries', async () => {
    await book('2026-11-28', '2026-12-03');
    await book('2026-10-28', '2026-11-03');
    await book('2026-11-10', '2026-11-12');
    const response = await app.inject({ url: url(), cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.bookedRanges).toEqual([
      { checkIn: '2026-10-28', checkOut: '2026-11-03' },
      { checkIn: '2026-11-10', checkOut: '2026-11-12' },
      { checkIn: '2026-11-28', checkOut: '2026-12-03' },
    ]);
    expect(response.body).not.toMatch(
      /Private Guest|66812345678|private@example|guestName|guestPhone|guestEmail|userId|bookingId/,
    );
    for (const range of response.json().data.bookedRanges)
      expect(Object.keys(range).sort()).toEqual(['checkIn', 'checkOut']);
  });
  it('includes a range spanning the entire query without clipping', async () => {
    await book('2026-10-20', '2026-12-10');
    expect((await app.inject({ url: url(), cookies })).json().data.bookedRanges).toEqual([
      { checkIn: '2026-10-20', checkOut: '2026-12-10' },
    ]);
  });
  it('excludes touching boundaries, cancelled records and other rooms', async () => {
    await book('2026-10-28', '2026-11-01');
    await book('2026-12-01', '2026-12-03');
    await book('2026-11-10', '2026-11-12', roomId, 'cancelled');
    await book('2026-11-10', '2026-11-12', otherId);
    expect((await app.inject({ url: url(), cookies })).json().data.bookedRanges).toEqual([]);
  });
  it.each([inactiveId, missingId])('hides inactive/missing room %s as 404', async id => {
    const response = await app.inject({ url: url(undefined, id), cookies });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROOM_NOT_FOUND');
  });
  it.each([
    ['', 'REQUIRED'],
    ['from=2026-11-01', 'REQUIRED'],
    ['from=2026-11-01&to=2026-11-01', 'MUST_BE_AFTER_FROM'],
    ['from=2026-11-02&to=2026-11-01', 'MUST_BE_AFTER_FROM'],
    ['from=2026-01-01&to=2026-04-05', 'RANGE_TOO_LARGE'],
    ['from=2026-02-30&to=2026-03-02', 'INVALID_FORMAT'],
    ['from=2026-11-01T00:00:00Z&to=2026-12-01', 'INVALID_FORMAT'],
    ['from=2026-11-01&to=2026-12-01&extra=true', 'UNKNOWN_FIELD'],
    ['from=2026-11-01&from=2026-11-02&to=2026-12-01', 'INVALID_TYPE'],
  ])('rejects invalid query %s with %s', async (query, code) => {
    const response = await app.inject({ url: url(query), cookies });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });
  it('rejects invalid UUID and unexpected rooms query', async () => {
    const invalid = await app.inject({ url: url(undefined, 'bad'), cookies });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.fields[0].field).toBe('roomId');
    expect((await app.inject({ url: '/api/v1/rooms?extra=true', cookies })).statusCode).toBe(422);
  });
  it.each([
    'from=2026-01-01&to=2026-01-02',
    'from=2026-01-01&to=2026-04-04',
    'from=2028-02-29&to=2028-03-01',
  ])('accepts valid historical, 93-day and leap-year queries: %s', async query => {
    expect((await app.inject({ url: url(query), cookies })).statusCode).toBe(200);
  });
  it('preserves date strings even with a non-UTC database session timezone', async () => {
    await book('2026-11-10', '2026-11-12');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("SET TIME ZONE 'America/Los_Angeles'");
        const pg = new PgCalendarRepository(client as unknown as Pool);
        expect(await pg.bookedRanges(roomId, '2026-11-01', '2026-12-01')).toEqual([
          { checkIn: '2026-11-10', checkOut: '2026-11-12' },
        ]);
      } finally {
        await client.query("SET TIME ZONE 'UTC'");
        client.release();
      }
    } else
      expect((await app.inject({ url: url(), cookies })).json().data.bookedRanges[0].checkIn).toBe(
        '2026-11-10',
      );
  });
  it('does not expose database errors from calendar or room lookup', async () => {
    vi.spyOn(repository, 'bookedRanges').mockRejectedValueOnce(
      new Error('SQL private guest@example.com'),
    );
    const response = await app.inject({ url: url(), cookies });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toMatch(/SQL|guest@example/);
    vi.spyOn(repository, 'listActiveRooms').mockRejectedValueOnce(new Error('database failure'));
    expect((await app.inject({ url: '/api/v1/rooms', cookies })).statusCode).toBe(500);
  });
});

describe('calendar dates and rules', () => {
  it.each(['2026-02-29', '0000-01-01', '2026-13-01', '2026-00-01', '2026-1-01', '', 'not-a-date'])(
    'rejects invalid LocalDate %s',
    value => {
      expect(localDate.safeParse(value).success).toBe(false);
    },
  );
  it.each(['2028-02-29', '2026-12-31', '0001-01-01', '9999-12-31'])(
    'accepts real date %s',
    value => {
      expect(localDate.safeParse(value).success).toBe(true);
    },
  );
  it('computes Bangkok midnight across month/year correctly', () => {
    expect(bangkokToday(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01');
    expect(bangkokToday(new Date('2026-02-28T17:00:00Z'))).toBe('2026-03-01');
  });
  it('reports an invalid end date as a format error', () => {
    expect(() => validate(calendarQuery, { from: '2026-11-01', to: 'invalid' })).toThrow();
  });
  it('returns configured rules without exposing mutable configuration', async () => {
    const repo = new MemoryCalendar();
    const rules = { maxNights: 14, maxAdvanceDays: 90 };
    const service = new CalendarService(repo, () => new Date('2026-11-05T17:00:00Z'), rules);
    rules.maxNights = 999;
    const result = await service.calendar(roomId, '2026-11-01', '2026-12-01');
    expect(result.bookingRules).toEqual({ maxNights: 14, maxAdvanceDays: 90 });
    result.bookingRules.maxNights = 888;
    expect(
      (await service.calendar(roomId, '2026-11-01', '2026-12-01')).bookingRules.maxNights,
    ).toBe(14);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid rule %s',
    value => {
      expect(
        () =>
          new CalendarService(new MemoryCalendar(), undefined, {
            maxNights: value,
            maxAdvanceDays: 365,
          }),
      ).toThrow();
      expect(
        () =>
          new CalendarService(new MemoryCalendar(), undefined, {
            maxNights: 30,
            maxAdvanceDays: value,
          }),
      ).toThrow();
    },
  );
  it('uses default real clock when no clock is injected', async () => {
    const service = new CalendarService(new MemoryCalendar());
    const result = await service.calendar(roomId, '2026-11-01', '2026-12-01');
    expect(localDate.safeParse(result.today).success).toBe(true);
  });
});

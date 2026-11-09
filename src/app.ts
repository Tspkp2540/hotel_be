import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { AuthService, passwordHasher, type PasswordHasher } from './auth/service.js';
import { publicUser, type AuthRepository } from './auth/repository.js';
import { validate, registerSchema, loginSchema, emptyQuery } from './auth/validation.js';
import type { CalendarRepository } from './calendar/repository.js';
import { CalendarService, type BookingRules } from './calendar/service.js';
import { calendarQuery, roomParams } from './calendar/dates.js';
import { publicBooking, type BookingRepository } from './booking/repository.js';
import { BookingService } from './booking/service.js';
import { createBookingSchema, requestKeySchema, requestKeyParams, bookingListQuery, bookingParams } from './booking/validation.js';
import { MemoryRateLimitStore, RateLimiter, RateLimitError, type RateLimitStore } from './security/rate-limit.js';
import { validateOrigin, parseTrustedProxies } from './security/config.js';

export type AppOptions = {
  repository: AuthRepository; frontendOrigin: string; production?: boolean;
  clock?: () => Date; hasher?: PasswordHasher; logger?: boolean;
  calendarRepository?: CalendarRepository; bookingRules?: BookingRules;
  bookingRepository?: BookingRepository;
  rateLimitStore?: RateLimitStore; trustedProxyCidrs?: string[];
  logStream?: { write(message: string): void };
};
export async function buildApp(options: AppOptions) {
  validateOrigin(options.frontendOrigin, options.production ?? false);
  const proxies = parseTrustedProxies((options.trustedProxyCidrs ?? []).join(','));
  const securityHeaders = (reply: import('fastify').FastifyReply, id: string) => {
    reply.header('X-Request-Id', id).header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (options.production) reply.header('Strict-Transport-Security', 'max-age=31536000');
  };
  const app = Fastify({ bodyLimit: 16384, requestTimeout: 30000, connectionTimeout: 10000, keepAliveTimeout: 5000,
    onProtoPoisoning: 'error', onConstructorPoisoning: 'error',
    requestIdHeader: false, exposeHeadRoutes: false, trustProxy: proxies.length ? proxies : false,
    frameworkErrors: (_error, request, reply) => {
      // Router failures occur before normal hooks; never echo the raw URL or framework error.
      const response: import('fastify').FastifyReply = reply;
      securityHeaders(response, request.id);
      if (request.headers.origin === options.frontendOrigin) response.header('Access-Control-Allow-Origin', options.frontendOrigin)
        .header('Access-Control-Allow-Credentials', 'true').header('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After').header('Vary', 'Origin');
      response.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'รูปแบบคำขอไม่ถูกต้อง', fields: [], requestId: request.id } });
    },
    genReqId: () => randomUUID(), logger: options.logger ? {
    stream: options.logStream,
    serializers: { req: (request: { method: string }) => ({ method: request.method }) },
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  } : false });
  const clock = options.clock ?? (() => new Date());
  const hasher = options.hasher ?? passwordHasher;
  const auth = new AuthService(options.repository, hasher, await hasher.hash(randomUUID()), clock);
  const limiter = new RateLimiter(options.rateLimitStore ?? new MemoryRateLimitStore(), clock);
  const sessions = new WeakMap<import('fastify').FastifyRequest, Awaited<ReturnType<AuthService['me']>>>();
  const sessionFor = async (request: import('fastify').FastifyRequest) => sessions.get(request) ?? await auth.me(request.cookies[cookieName]);
  const cookieName = options.production ? '__Host-booking_session' : 'booking_session';
  const cookieOptions = { httpOnly: true, secure: options.production ?? false, sameSite: 'lax' as const, path: '/' };
  await app.register(cookie);
  // Origin protection runs before JSON parsing, including login and logout.
  app.addHook('onRequest', async (request, reply) => {
    securityHeaders(reply, request.id);
    if (request.method === 'POST' && request.headers.origin !== options.frontendOrigin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'ไม่อนุญาต Origin นี้');
  });
  // Allowed browser clients must also be able to read errors from the limiter/session store.
  await app.register(cors, {
    origin: (incoming, callback) => callback(null, incoming === options.frontendOrigin), credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'], exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });
  app.addHook('onRequest', async request => {
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0];
    if (path === '/api/v1/auth/register' && request.method === 'POST') await limiter.check('register-ip', request.ip, 5, 900000);
    else if (path === '/api/v1/auth/login' && request.method === 'POST') await limiter.check('login-ip', request.ip, 20, 900000);
    else {
      if (request.cookies[cookieName]) {
        try { sessions.set(request, await auth.me(request.cookies[cookieName])); }
        catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
      }
      const session = sessions.get(request);
      await limiter.check(session ? 'general-user' : 'general-ip', session?.user.id ?? request.ip, 120, 60000);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    let api: ApiError;
    if (error instanceof ApiError) api = error;
    else if (status === 413) api = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลมีขนาดใหญ่เกินกำหนด');
    else if (status === 415) api = new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'รองรับเฉพาะ application/json');
    else if (status === 400) api = new ApiError(400, 'INVALID_JSON', 'JSON ไม่ถูกต้อง');
    else api = new ApiError(500, 'INTERNAL_ERROR', 'เกิดข้อผิดพลาดภายในระบบ');
    // Do not log raw exceptions: driver errors may contain PII or query parameters.
    if (api.status === 500) request.log.error({ requestId: request.id }, 'Internal request failure');
    if (error instanceof RateLimitError) reply.header('Retry-After', error.retryAfter);
    reply.code(api.status).send({ error: { code: api.code, message: api.message, fields: api.fields, requestId: request.id } });
  });
  app.setNotFoundHandler(() => { throw new ApiError(404, 'NOT_FOUND', 'ไม่พบข้อมูล'); });
  app.addHook('preValidation', async request => {
    if (request.method !== 'OPTIONS' && request.url.startsWith('/api/v1/auth/')) validate(emptyQuery, request.query);
    if (request.method === 'POST' && request.url.split('?')[0] !== '/api/v1/auth/logout'
      && !(request.routeOptions.url === '/api/v1/bookings/:bookingId/cancel' && request.body === undefined)
      && request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'รองรับเฉพาะ application/json');
    }
  });
  app.post('/api/v1/auth/register', async (request, reply) => {
    const input = validate(registerSchema, request.body);
    return reply.code(201).send({ data: { user: publicUser(await auth.register(input)) } });
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = validate(loginSchema, request.body);
    await limiter.check('login-email', input.email, 10, 900000);
    const result = await auth.login(input);
    reply.setCookie(cookieName, result.token, { ...cookieOptions, maxAge: 604800, expires: result.expiresAt });
    return { data: { user: publicUser(result.user), sessionExpiresAt: result.expiresAt.toISOString() } };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.body !== undefined) throw new ApiError(422, 'VALIDATION_ERROR', 'Logout ไม่รับ request body');
    await auth.logout(request.cookies[cookieName]);
    reply.clearCookie(cookieName, cookieOptions).code(204).send();
  });
  app.get('/api/v1/auth/me', async request => {
    const session = await sessionFor(request);
    return { data: {user:publicUser(session.user),sessionExpiresAt:session.sessionExpiresAt} };
  });
  if (options.calendarRepository) {
    const calendar = new CalendarService(options.calendarRepository, clock, options.bookingRules);
    const requireLogin = async (request: import('fastify').FastifyRequest) => { await sessionFor(request); };
    app.get('/api/v1/rooms', { preHandler: requireLogin }, async request => {
      validate(emptyQuery, request.query);
      return { data: await calendar.rooms() };
    });
    app.get('/api/v1/rooms/:roomId/calendar', { preHandler: requireLogin }, async request => {
      const { roomId } = validate(roomParams, request.params);
      const { from, to } = validate(calendarQuery, request.query);
      return { data: await calendar.calendar(roomId, from, to) };
    });
  }
  if (options.bookingRepository) {
    const booking = new BookingService(options.bookingRepository, clock, options.bookingRules);
    app.post('/api/v1/bookings/:bookingId/cancel', async request => {
      const session = await sessionFor(request);
      await limiter.check('cancel-user',session.user.id,10,60000);
      validate(emptyQuery,request.query);
      const { bookingId } = validate(bookingParams,request.params);
      if (request.body !== undefined) throw new ApiError(422,'VALIDATION_ERROR','การยกเลิกไม่รับ request body');
      return {data:{booking:publicBooking(await booking.cancel(session.user.id,bookingId))}};
    });
    app.get('/api/v1/bookings', async request => {
      const session = await sessionFor(request);
      const { limit, cursor } = validate(bookingListQuery, request.query);
      const page = await options.bookingRepository!.listForUser(session.user.id, limit, cursor);
      return { data: { bookings:page.bookings.map(item => ({...publicBooking(item),roomName:item.roomName})),nextCursor:page.nextCursor } };
    });
    app.post('/api/v1/bookings', async (request, reply) => {
      const session = await sessionFor(request);
      await limiter.check('booking-user', session.user.id, 10, 60000);
      validate(emptyQuery, request.query);
      const input = validate(createBookingSchema, request.body);
      const rawKey = request.headers['idempotency-key'];
      const key = rawKey === undefined ? undefined : validate(requestKeySchema, rawKey);
      return reply.code(201).send({ data: { booking: publicBooking(await booking.create(session.user.id, input, key)) } });
    });
    app.get('/api/v1/bookings/requests/:requestKey', async request => {
      const session = await sessionFor(request);
      validate(emptyQuery, request.query);
      const { requestKey } = validate(requestKeyParams, request.params);
      const result = await options.bookingRepository!.findByRequest(session.user.id, requestKey);
      if (!result) throw new ApiError(404, 'BOOKING_REQUEST_NOT_FOUND', 'ยังไม่พบผลการจองสำหรับคำขอนี้');
      return { data: { booking: publicBooking(result) } };
    });
  }
  return app;
}

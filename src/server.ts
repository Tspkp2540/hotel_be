import { Pool } from 'pg';
import { buildApp } from './app.js';
import { PgAuthRepository } from './auth/repository.js';
import { PgCalendarRepository } from './calendar/repository.js';
import { PgBookingRepository } from './booking/repository.js';
import { PgRateLimitStore } from './security/rate-limit.js';
import { parseTrustedProxies } from './security/config.js';
import { cleanupExpiredState } from './security/maintenance.js';

if (!process.env.DATABASE_URL || !process.env.FRONTEND_ORIGIN) throw new Error('DATABASE_URL and FRONTEND_ORIGIN are required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
const rateLimitStore = new PgRateLimitStore(pool);
const app = await buildApp({
  repository: new PgAuthRepository(pool), calendarRepository: new PgCalendarRepository(pool),
  bookingRepository: new PgBookingRepository(pool),
  rateLimitStore, trustedProxyCidrs: parseTrustedProxies(process.env.TRUSTED_PROXY_CIDRS),
  frontendOrigin: process.env.FRONTEND_ORIGIN, production: process.env.NODE_ENV === 'production', logger: true,
  bookingRules: { maxNights: Number(process.env.MAX_BOOKING_NIGHTS ?? 30), maxAdvanceDays: Number(process.env.MAX_ADVANCE_DAYS ?? 365) },
});
let maintenance: Promise<void> | undefined;
const cleanupTimer = setInterval(() => {
  if (!maintenance) maintenance = cleanupExpiredState(pool, new Date())
    .catch(() => { app.log.error('Expired state cleanup failed'); })
    .finally(() => { maintenance = undefined; });
}, 60000);
cleanupTimer.unref();
app.addHook('onClose', async () => { clearInterval(cleanupTimer); await maintenance; await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); });
await pool.query('SELECT 1');
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' });

import type { Pool } from 'pg';
import { PgRateLimitStore } from './rate-limit.js';

export async function cleanupExpiredState(pool: Pool, now: Date): Promise<void> {
  // Expiry is still checked on requests; cleanup is only storage maintenance.
  await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
  await new PgRateLimitStore(pool).cleanup(now);
}

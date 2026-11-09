import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from '../errors.js';

type Bucket = { attempts: number; expiresAt: Date };
export interface RateLimitStore {
  consume(key: string, max: number, windowMs: number, now: Date): Promise<Bucket>;
}
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  async consume(key: string, max: number, windowMs: number, now: Date): Promise<Bucket> {
    for (const [id, bucket] of this.buckets)
      if (bucket.expiresAt.getTime() <= now.getTime()) this.buckets.delete(id);
    const bucket = this.buckets.get(key) ?? {
      attempts: 0,
      expiresAt: new Date(now.getTime() + windowMs),
    };
    bucket.attempts = Math.min(bucket.attempts + 1, max + 1);
    this.buckets.set(key, bucket);
    return { ...bucket };
  }
}
export class PgRateLimitStore implements RateLimitStore {
  constructor(private pool: Pool) {}
  async consume(key: string, max: number, windowMs: number, now: Date): Promise<Bucket> {
    const result = await this.pool.query<{ attempts: number; expires_at: Date }>(
      `
      INSERT INTO rate_limit_buckets(key_hash,attempts,expires_at) VALUES($1,1,$2)
      ON CONFLICT(key_hash) DO UPDATE SET
        attempts=CASE WHEN rate_limit_buckets.expires_at <= $3 THEN 1 ELSE LEAST(rate_limit_buckets.attempts+1,$4) END,
        expires_at=CASE WHEN rate_limit_buckets.expires_at <= $3 THEN EXCLUDED.expires_at ELSE rate_limit_buckets.expires_at END
      RETURNING attempts,expires_at`,
      [key, new Date(now.getTime() + windowMs), now, max + 1],
    );
    return { attempts: result.rows[0].attempts, expiresAt: result.rows[0].expires_at };
  }
  async cleanup(now: Date) {
    await this.pool.query('DELETE FROM rate_limit_buckets WHERE expires_at <= $1', [now]);
  }
}
export class RateLimitError extends ApiError {
  constructor(public retryAfter: number) {
    super(429, 'RATE_LIMITED', 'กรุณาลองใหม่ภายหลัง');
  }
}
export class RateLimiter {
  constructor(
    private store: RateLimitStore,
    private clock: () => Date,
  ) {}
  async check(scope: string, identity: string, max: number, windowMs: number) {
    // Hash scoped identifiers so the infrastructure table does not contain raw email/IP/user IDs.
    const key = createHash('sha256')
      .update(JSON.stringify([scope, identity]))
      .digest('hex');
    const now = this.clock();
    const bucket = await this.store.consume(key, max, windowMs, now);
    if (bucket.attempts > max)
      throw new RateLimitError(
        Math.max(1, Math.ceil((bucket.expiresAt.getTime() - now.getTime()) / 1000)),
      );
  }
}

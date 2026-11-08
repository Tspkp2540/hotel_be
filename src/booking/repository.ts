import type { Pool } from 'pg';
import { ApiError } from '../errors.js';
import type { CreateBooking } from './validation.js';

export type Booking = CreateBooking & { id: string; nights: number; status: 'confirmed' | 'cancelled'; createdAt: string };
export interface BookingRepository {
  create(userId: string, input: CreateBooking, requestKey?: string): Promise<Booking>;
  findByRequest(userId: string, requestKey: string): Promise<Booking | null>;
}
const selection = `id,room_id AS "roomId",to_char(check_in,'YYYY-MM-DD') AS "checkIn",
  to_char(check_out,'YYYY-MM-DD') AS "checkOut",check_out-check_in AS nights,
  guest_name AS "guestName",guest_phone AS "guestPhone",guest_email AS "guestEmail",status,created_at AS "createdAt"`;
type Row = Omit<Booking, 'createdAt'> & { createdAt: Date };
const serialize = (row: Row): Booking => ({ ...row, createdAt: row.createdAt.toISOString() });
export function checkReplay(booking: Booking, input: CreateBooking): Booking {
  if ((Object.keys(input) as Array<keyof CreateBooking>).some(key => booking[key] !== input[key])) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'รหัสคำขอนี้ถูกใช้กับข้อมูลอื่นแล้ว');
  return booking;
}
export class PgBookingRepository implements BookingRepository {
  constructor(private pool: Pool) {}
  async findByRequest(userId: string, requestKey: string): Promise<Booking | null> {
    const result = await this.pool.query<Row>(`SELECT ${selection} FROM bookings WHERE user_id=$1 AND request_key=$2`, [userId, requestKey]);
    return result.rows[0] ? serialize(result.rows[0]) : null;
  }
  async create(userId: string, input: CreateBooking, requestKey?: string): Promise<Booking> {
    const client = await this.pool.connect();
    let brokenConnection = false;
    try {
      await client.query('BEGIN');
      if (requestKey) {
        // A transaction-scoped lock serializes the same user/key across server instances.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${userId}:${requestKey}`]);
        const previous = await client.query<Row>(`SELECT ${selection} FROM bookings WHERE user_id=$1 AND request_key=$2`, [userId, requestKey]);
        if (previous.rows[0]) {
          const replay = checkReplay(serialize(previous.rows[0]), input);
          await client.query('COMMIT'); return replay;
        }
      }
      const room = await client.query<{ is_active: boolean }>('SELECT is_active FROM rooms WHERE id=$1::uuid FOR SHARE', [input.roomId]);
      if (!room.rows[0]) throw new ApiError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้อง');
      if (!room.rows[0].is_active) throw new ApiError(409, 'ROOM_UNAVAILABLE', 'ห้องปิดรับจอง');
      const result = await client.query<Row>(`
        INSERT INTO bookings(user_id,room_id,check_in,check_out,guest_name,guest_phone,guest_email,request_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${selection}`,
      [userId, input.roomId, input.checkIn, input.checkOut, input.guestName, input.guestPhone, input.guestEmail, requestKey ?? null]);
      await client.query('COMMIT');
      return serialize(result.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch { brokenConnection = true; }
      throw error;
    } finally { client.release(brokenConnection); }
  }
}


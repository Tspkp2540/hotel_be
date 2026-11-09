import type { Pool } from 'pg';
import { ApiError } from '../errors.js';
import type { CreateBooking } from './validation.js';

export type Booking = CreateBooking & { id: string; nights: number; status: 'confirmed' | 'cancelled'; createdAt: string };
export type BookingPage = { bookings: Array<Booking & { roomName: string }>; nextCursor: string | null };
export interface BookingRepository {
  cancel(userId: string, bookingId: string, today: string, now: Date): Promise<Booking>;
  listForUser(userId: string, limit: number, cursor?: string): Promise<BookingPage>;
  create(userId: string, input: CreateBooking, requestKey?: string): Promise<Booking>;
  findByRequest(userId: string, requestKey: string): Promise<Booking | null>;
}
const selection = `id,room_id AS "roomId",to_char(check_in,'YYYY-MM-DD') AS "checkIn",
  to_char(check_out,'YYYY-MM-DD') AS "checkOut",check_out-check_in AS nights,
  guest_name AS "guestName",guest_phone AS "guestPhone",guest_email AS "guestEmail",status,created_at AS "createdAt"`;
type Row = Omit<Booking, 'createdAt'> & { createdAt: Date };
const serialize = (row: Row): Booking => ({ id:row.id,roomId:row.roomId,checkIn:row.checkIn,checkOut:row.checkOut,
  guestName:row.guestName,guestPhone:row.guestPhone,guestEmail:row.guestEmail,nights:row.nights,status:row.status,createdAt:row.createdAt.toISOString() });
export const publicBooking = (booking: Booking): Booking => ({ id:booking.id,roomId:booking.roomId,checkIn:booking.checkIn,checkOut:booking.checkOut,
  guestName:booking.guestName,guestPhone:booking.guestPhone,guestEmail:booking.guestEmail,nights:booking.nights,status:booking.status,createdAt:booking.createdAt });
export function checkReplay(booking: Booking, input: CreateBooking): Booking {
  if ((Object.keys(input) as Array<keyof CreateBooking>).some(key => booking[key] !== input[key])) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'รหัสคำขอนี้ถูกใช้กับข้อมูลอื่นแล้ว');
  return booking;
}
export class PgBookingRepository implements BookingRepository {
  constructor(private pool: Pool) {}
  async cancel(userId: string, bookingId: string, today: string, now: Date): Promise<Booking> {
    const result = await this.pool.query<Row>(`UPDATE bookings SET status='cancelled',
      cancelled_at=COALESCE(cancelled_at,$4),updated_at=CASE WHEN status='confirmed' THEN $4 ELSE updated_at END
      WHERE user_id=$1 AND id=$2 AND (status='cancelled' OR check_in>$3::date)
      RETURNING ${selection}`, [userId,bookingId,today,now]);
    if (result.rows[0]) return serialize(result.rows[0]);
    const own = await this.pool.query('SELECT id FROM bookings WHERE user_id=$1 AND id=$2',[userId,bookingId]);
    if (!own.rows.length) throw new ApiError(404,'BOOKING_NOT_FOUND','ไม่พบรายการจอง');
    throw new ApiError(409,'CANCELLATION_NOT_ALLOWED','ยกเลิกได้ก่อนวันเข้าพักเท่านั้น');
  }
  async listForUser(userId: string, limit: number, cursor?: string): Promise<BookingPage> {
    // Resolve the cursor inside the owner's rows; keep PostgreSQL timestamp precision.
    if (cursor) {
      const anchor = await this.pool.query('SELECT id FROM bookings WHERE user_id=$1 AND id=$2', [userId, cursor]);
      if (!anchor.rows.length) throw new ApiError(422, 'VALIDATION_ERROR', 'ตำแหน่งรายการไม่ถูกต้อง กรุณาโหลดหน้าใหม่');
    }
    const result = await this.pool.query<Row & { roomName: string }>(`
      SELECT history.*,rooms.name AS "roomName" FROM (
        SELECT ${selection} FROM bookings WHERE user_id=$1
          AND ($2::uuid IS NULL OR (created_at,id) <
            (SELECT created_at,id FROM bookings WHERE user_id=$1 AND id=$2))
        ORDER BY created_at DESC,id DESC LIMIT $3
      ) history JOIN rooms ON rooms.id=history."roomId"
      ORDER BY history."createdAt" DESC,history.id DESC`, [userId, cursor ?? null, limit + 1]);
    const bookings = result.rows.slice(0, limit).map(row => ({ ...serialize(row), roomName: row.roomName }));
    return { bookings, nextCursor: result.rows.length > limit ? bookings[bookings.length - 1].id : null };
  }
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


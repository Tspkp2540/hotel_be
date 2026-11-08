import type { Pool } from 'pg';

export type Room = { id: string; name: string };
export type BookedRange = { checkIn: string; checkOut: string };
export interface CalendarRepository {
  listActiveRooms(): Promise<Room[]>;
  isRoomActive(roomId: string): Promise<boolean>;
  bookedRanges(roomId: string, from: string, to: string): Promise<BookedRange[]>;
}

export class PgCalendarRepository implements CalendarRepository {
  constructor(private pool: Pool) {}
  async listActiveRooms(): Promise<Room[]> {
    const result = await this.pool.query<Room>('SELECT id,name FROM rooms WHERE is_active=TRUE ORDER BY created_at ASC,id ASC');
    return result.rows;
  }
  async isRoomActive(roomId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT id FROM rooms WHERE id=$1::uuid AND is_active=TRUE', [roomId]);
    return result.rows.length > 0;
  }
  async bookedRanges(roomId: string, from: string, to: string): Promise<BookedRange[]> {
    // Format DATE in SQL to avoid node-postgres converting business dates to local Date objects.
    const result = await this.pool.query<BookedRange>(`
      SELECT to_char(check_in,'YYYY-MM-DD') AS "checkIn", to_char(check_out,'YYYY-MM-DD') AS "checkOut"
      FROM bookings
      WHERE room_id=$1::uuid AND status='confirmed'
        AND daterange(check_in,check_out,'[)') && daterange($2::date,$3::date,'[)')
      ORDER BY check_in ASC`, [roomId, from, to]);
    return result.rows;
  }
}

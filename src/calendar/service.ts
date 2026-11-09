import { ApiError } from '../errors.js';
import { bangkokToday } from './dates.js';
import type { CalendarRepository } from './repository.js';

export type BookingRules = { maxNights: number; maxAdvanceDays: number };
export const DEFAULT_BOOKING_RULES: Readonly<BookingRules> = Object.freeze({ maxNights: 30, maxAdvanceDays: 365 });
export function copyBookingRules(rules: BookingRules): BookingRules {
  if (![rules.maxNights, rules.maxAdvanceDays].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Booking rules must be positive safe integers');
  return { ...rules };
}
export class CalendarService {
  private rules: BookingRules;
  constructor(private repository: CalendarRepository, private clock: () => Date = () => new Date(), rules: BookingRules = DEFAULT_BOOKING_RULES) {
    this.rules = copyBookingRules(rules);
  }
  async rooms() { return { rooms: (await this.repository.listActiveRooms()).map(room => ({id:room.id,name:room.name,hotelName:room.hotelName,province:room.province})) }; }
  async calendar(roomId: string, from: string, to: string) {
    if (!await this.repository.isRoomActive(roomId)) throw new ApiError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องที่เปิดรับจอง');
    return {
      roomId, timezone: 'Asia/Bangkok', today: bangkokToday(this.clock()),
      bookingRules: { ...this.rules }, from, to,
      bookedRanges: (await this.repository.bookedRanges(roomId, from, to)).map(range => ({checkIn:range.checkIn,checkOut:range.checkOut})),
    };
  }
}

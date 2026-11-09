import { ApiError, type FieldError } from '../errors.js';
import { bangkokToday } from '../calendar/dates.js';
import { copyBookingRules, DEFAULT_BOOKING_RULES, type BookingRules } from '../calendar/service.js';
import { checkReplay, type BookingRepository } from './repository.js';
import type { CreateBooking } from './validation.js';

export class BookingService {
  private rules: BookingRules;
  async cancel(userId: string, bookingId: string) {
    const now = this.clock();
    return this.repository.cancel(userId, bookingId, bangkokToday(now), now);
  }
  constructor(
    private repository: BookingRepository,
    private clock: () => Date = () => new Date(),
    rules: BookingRules = DEFAULT_BOOKING_RULES,
  ) {
    this.rules = copyBookingRules(rules);
  }
  async create(userId: string, input: CreateBooking, requestKey?: string) {
    // A committed request remains replayable after dates/rules or room availability change.
    if (requestKey) {
      const previous = await this.repository.findByRequest(userId, requestKey);
      if (previous) return checkReplay(previous, input);
    }
    // Input has already passed strict LocalDate validation; UTC arithmetic here counts calendar days.
    const today = bangkokToday(this.clock());
    const nights = (Date.parse(input.checkOut) - Date.parse(input.checkIn)) / 86400000;
    const advance = (Date.parse(input.checkIn) - Date.parse(today)) / 86400000;
    const fields: FieldError[] = [];
    if (advance < 0)
      fields.push({ field: 'checkIn', code: 'DATE_IN_PAST', message: 'วันเข้าพักอยู่ในอดีต' });
    if (advance > this.rules.maxAdvanceDays)
      fields.push({
        field: 'checkIn',
        code: 'TOO_FAR_IN_ADVANCE',
        message: 'วันเข้าพักเกินช่วงที่เปิดให้จอง',
      });
    if (nights <= 0)
      fields.push({
        field: 'checkOut',
        code: 'MUST_BE_AFTER_CHECK_IN',
        message: 'วันออกต้องอยู่หลังวันเข้า',
      });
    if (nights > this.rules.maxNights)
      fields.push({ field: 'checkOut', code: 'MAX_NIGHTS_EXCEEDED', message: 'จำนวนคืนเกินกำหนด' });
    if (fields.length) throw new ApiError(422, 'VALIDATION_ERROR', 'ข้อมูลไม่ถูกต้อง', fields);
    try {
      return await this.repository.create(userId, input, requestKey);
    } catch (error) {
      const db = error as { code?: string; constraint?: string };
      if (db.code === '23P01' && db.constraint === 'prevent_overlapping_bookings')
        throw new ApiError(409, 'BOOKING_CONFLICT', 'ช่วงวันที่เลือกถูกจองแล้ว กรุณาเลือกวันใหม่');
      throw error;
    }
  }
}

import { z } from 'zod';
import { localDate } from '../calendar/dates.js';
import { emailSchema, fullNameSchema } from '../auth/validation.js';

export const createBookingSchema = z.strictObject({
  roomId: z.uuid().transform(value => value.toLowerCase()), checkIn: localDate, checkOut: localDate,
  guestName: fullNameSchema,
  guestPhone: z.string().trim().regex(/^\+[1-9][0-9]{1,14}$/),
  guestEmail: emailSchema,
});
export type CreateBooking = z.infer<typeof createBookingSchema>;
export const requestKeySchema = z.uuid().transform(value => value.toLowerCase());
export const requestKeyParams = z.strictObject({ requestKey: requestKeySchema });
export const bookingParams = z.strictObject({ bookingId: requestKeySchema });
export const bookingListQuery = z.strictObject({
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default('20').transform(Number),
  cursor: requestKeySchema.optional(),
});

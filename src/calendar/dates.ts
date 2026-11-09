import { z } from 'zod';

const DAY_MS = 86400000;
export const localDate = z.string().refine(
  value => {
    if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  },
  { message: 'ต้องเป็นวันที่จริงรูปแบบ YYYY-MM-DD', params: { apiCode: 'INVALID_FORMAT' } },
);

export const roomParams = z.strictObject({ roomId: z.uuid() });
export const calendarQuery = z
  .strictObject({ from: localDate, to: localDate })
  .superRefine((value, ctx) => {
    // Only compare parsed, valid dates; never normalize an impossible calendar date.
    if (!localDate.safeParse(value.from).success || !localDate.safeParse(value.to).success) return;
    const days = (Date.parse(value.to) - Date.parse(value.from)) / DAY_MS;
    if (days <= 0)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'วันสิ้นสุดต้องอยู่หลังวันเริ่ม',
        params: { apiCode: 'MUST_BE_AFTER_FROM' },
      });
    else if (days > 93)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'ช่วงวันที่ต้องไม่เกิน 93 วัน',
        params: { apiCode: 'RANGE_TOO_LARGE' },
      });
  });

const bangkokFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function bangkokToday(now: Date): string {
  const parts = bangkokFormatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

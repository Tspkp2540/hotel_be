import { z } from 'zod';
import { ApiError } from '../errors.js';

const length = (s: string) => [...s].length;
const email = z.string().trim().toLowerCase().max(254).email();
const password = z
  .string()
  .refine(s => length(s) >= 12 && length(s) <= 128, 'Password must contain 12–128 characters');
const name = z
  .string()
  .trim()
  .refine(s => !s.includes('\u0000'), {
    message: 'ชื่อต้องไม่มีอักขระ NUL',
    params: { apiCode: 'INVALID_FORMAT' },
  })
  .refine(s => length(s) >= 1 && length(s) <= 150, 'Name must contain 1–150 characters');
export { email as emailSchema, name as fullNameSchema };
export const registerSchema = z.strictObject({ email, password, fullName: name });
export const loginSchema = z.strictObject({ email, password });
export const emptyQuery = z.strictObject({});

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ApiError(
    422,
    'VALIDATION_ERROR',
    'ข้อมูลไม่ถูกต้อง',
    result.error.issues.flatMap(issue => {
      if (issue.code === 'unrecognized_keys')
        return issue.keys.map(field => ({
          field,
          code: 'UNKNOWN_FIELD',
          message: 'ไม่รองรับ field นี้',
        }));
      const field = issue.path.join('.');
      const value = issue.path.reduce<unknown>(
        (current, key) =>
          current !== null && typeof current === 'object'
            ? (current as Record<PropertyKey, unknown>)[key]
            : undefined,
        input,
      );
      const code =
        issue.code === 'custom' && typeof issue.params?.apiCode === 'string'
          ? issue.params.apiCode
          : issue.code === 'invalid_type'
            ? value === undefined
              ? 'REQUIRED'
              : 'INVALID_TYPE'
            : issue.code === 'custom' || issue.code === 'too_big' || issue.code === 'too_small'
              ? 'INVALID_LENGTH'
              : 'INVALID_FORMAT';
      return [{ field, code, message: issue.message }];
    }),
  );
}

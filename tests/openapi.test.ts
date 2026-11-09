import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, it, expect } from 'vitest';
import { createBookingSchema } from '../src/booking/validation.js';
import { registerSchema, loginSchema } from '../src/auth/validation.js';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
describe('OpenAPI contract', () => {
  it('validates the complete document and contains seven core operations plus request recovery', async () => {
    const document = await SwaggerParser.validate(structuredClone(spec));
    expect(Object.values(document.paths!).flatMap(path => Object.keys(path!))).toHaveLength(10);
    expect(
      Object.values(document.paths!).flatMap(path =>
        Object.values(path!).map((op: any) => op.operationId),
      ),
    ).toEqual([
      'register',
      'login',
      'logout',
      'me',
      'rooms',
      'calendar',
      'createBooking',
      'myBookings',
      'bookingRequest',
      'cancelBooking',
    ]);
  });
  it('matches the deterministic committed generator output', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/generate-openapi.mjs', '--check'], {
        cwd: new URL('../', import.meta.url),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
  it('declares cookies, origin requirements, security and request types accurately', () => {
    expect(spec.components.securitySchemes.SessionCookie.name).toBe('__Host-booking_session');
    expect(spec.components.securitySchemes.DevelopmentSessionCookie.name).toBe('booking_session');
    for (const path of Object.values(spec.paths) as any[]) {
      if (path.post)
        expect(path.post.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'Origin', in: 'header', required: true }),
          ]),
        );
    }
    for (const path of ['/auth/me', '/rooms', '/rooms/{roomId}/calendar'])
      expect(spec.paths[path].get.security).toHaveLength(2);
    expect(spec.paths['/bookings'].post.security).toHaveLength(2);
    expect(spec.paths['/auth/logout'].post.requestBody).toBeUndefined();
  });
  it('agrees with runtime validators on representative normalized requests and rejected shapes', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const cases = [
      [
        'RegisterRequest',
        registerSchema,
        { email: 'test@example.com', password: 'password-test-123', fullName: 'Test' },
      ],
      ['LoginRequest', loginSchema, { email: 'test@example.com', password: 'password-test-123' }],
      [
        'CreateBookingRequest',
        createBookingSchema,
        {
          roomId: '7c71298a-ef46-457c-ab5e-9edb238a54e5',
          checkIn: '2026-11-10',
          checkOut: '2026-11-12',
          guestName: 'Test',
          guestPhone: '+66812345678',
          guestEmail: 'test@example.com',
        },
      ],
    ] as const;
    for (const [name, runtime, valid] of cases) {
      // Normalization extensions describe preprocessing JSON Schema cannot perform itself.
      const schema = structuredClone(spec.components.schemas[name]);
      for (const [key, property] of Object.entries(schema.properties) as [string, any][])
        if (property['x-normalized-schema'])
          schema.properties[key] = property['x-normalized-schema'];
      const check = ajv.compile(schema);
      expect(check(valid)).toBe(true);
      expect(runtime.safeParse(valid).success).toBe(true);
      for (const value of [
        { ...valid, unexpected: true },
        { ...valid, [Object.keys(valid)[0]]: null },
        {},
      ]) {
        expect(check(value)).toBe(false);
        expect(runtime.safeParse(value).success).toBe(false);
      }
    }
  });
});

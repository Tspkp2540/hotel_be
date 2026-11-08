import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'], // Do not discover isolated .mutation-work copies during normal runs.
    allowOnly: !process.env.CI,
    fileParallelism: false,
    coverage: {
      provider: 'v8', include: ['src/**/*.ts'],
      exclude: ['src/server.ts'], // Process bootstrap; exercised by build and real TCP smoke test.
      thresholds: {
        statements: 90, lines: 90, functions: 90, branches: 85,
        'src/auth/service.ts': { branches: 100 },
        'src/calendar/service.ts': { branches: 100 },
        'src/calendar/dates.ts': { branches: 100 },
        'src/booking/service.ts': { branches: 100 },
      },
    },
  },
});

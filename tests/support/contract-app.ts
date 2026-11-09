import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';
import { buildApp, type AppOptions } from '../../src/app.js';

const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validator(schema: object) {
  const key = JSON.stringify(schema);
  if (!validators.has(key))
    validators.set(key, ajv.compile({ components: spec.components, ...schema }));
  return validators.get(key)!;
}
// Test-only wrapper: the application still uses its normal serializers/handlers.
// Capture violations without changing the HTTP result, and fail when the test closes the app.
export async function buildTestApp(options: AppOptions) {
  const app = await buildApp(options);
  const violations: string[] = [];
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'OPTIONS') return payload;
    const template = request.routeOptions.url
      ?.replace(/^\/api\/v1/, '')
      .replace(/:([^/]+)/g, '{$1}');
    const operation = spec.paths[template ?? '']?.[request.method.toLowerCase()];
    const documented = operation?.responses[String(reply.statusCode)];
    if (operation && !documented)
      violations.push(`${request.method} ${template}: undocumented status ${reply.statusCode}`);
    const schema =
      documented?.content?.['application/json']?.schema ??
      (reply.statusCode >= 400 ? { $ref: '#/components/schemas/ErrorResponse' } : undefined);
    if (schema) {
      try {
        const parsed = JSON.parse(String(payload));
        const check = validator(schema);
        if (!check(parsed))
          violations.push(`${request.method} ${template}: ${ajv.errorsText(check.errors)}`);
      } catch (error) {
        violations.push(`Invalid JSON response: ${String(error)}`);
      }
    } else if (
      reply.statusCode === 204 &&
      payload !== null &&
      payload !== undefined &&
      payload !== ''
    )
      violations.push('204 must not contain a body');
    if (reply.getHeader('cache-control') !== 'no-store') violations.push('Missing no-store');
    if (reply.getHeader('x-content-type-options') !== 'nosniff') violations.push('Missing nosniff');
    if (reply.statusCode === 429 && !(Number(reply.getHeader('retry-after')) >= 1))
      violations.push('429 requires positive Retry-After');
    return payload;
  });
  app.addHook('onClose', async () => {
    expect(violations).toEqual([]);
  });
  return app;
}

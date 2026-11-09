import { isIP } from 'node:net';

export function validateOrigin(origin: string, production: boolean): string {
  const parsed = new URL(origin);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password
  )
    throw new Error('FRONTEND_ORIGIN must be an exact HTTP(S) origin without path or credentials');
  if (production && parsed.protocol !== 'https:')
    throw new Error('Production FRONTEND_ORIGIN requires HTTPS');
  return origin;
}
export function parseTrustedProxies(input = ''): string[] {
  if (!input.trim()) return [];
  return input.split(',').map(entry => {
    const value = entry.trim();
    const [address, mask, ...rest] = value.split('/');
    const version = isIP(address);
    if (
      !version ||
      rest.length ||
      (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)))
    )
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or CIDRs');
    return value;
  });
}

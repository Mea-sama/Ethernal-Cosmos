import type { IncomingHttpHeaders } from 'http';

/** Hinter einem Reverse-Proxy (Caddy) ist die Socket-Adresse die des Proxys: mit TRUST_PROXY=true gilt X-Forwarded-For. */
export function clientIp(headers: IncomingHttpHeaders, remoteAddress: string | undefined): string {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? 'unknown';
}

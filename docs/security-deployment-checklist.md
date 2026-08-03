# Security Deployment Checklist

This checklist covers items outside and inside the TypeScript codebase before public launch.

## 1) Edge / Reverse Proxy (outside project)

- Use HTTPS only at the public edge (Caddy).
- Redirect all HTTP traffic to HTTPS.
- Ensure only the intended external port is reachable from the internet.
- Keep certificate renewal healthy and monitored.

Suggested Caddy posture:

- Enforce TLS.
- Optionally mirror security headers at edge (defense in depth).
- Keep upstream connection to the internal hub locked to localhost/private network.

## 2) Firewall and Host Network (outside project)

- Allow inbound traffic only to the public reverse-proxy port.
- Block direct public access to internal Node process port.
- Restrict management ports (SSH/RDP/etc.) by source where possible.
- Keep host OS and runtime patched.

## 3) DNS and Domain

- Verify the production DNS name points only to the intended host.
- Remove stale DNS records not used in production.
- Confirm clients use the same canonical public origin used in ALLOWED_ORIGINS.

## 4) Required Environment Variables (inside deployment)

- `NODE_ENV=production`
- `JWT_SECRET=<strong random secret>`
- `ALLOWED_ORIGINS=<comma separated trusted origins>`
- Optional runtime values:
  - `PORT`
  - `HOST`

Do not launch publicly if required values are missing.

## 5) Application Security Settings (inside project)

Already implemented:

- Origin allowlisting for REST + Socket.io.
- Fail-closed JWT/production config validation.
- Strict CSP and baseline security headers.
- Self-hosted Socket.io browser client.
- Homepage escaping for game metadata.

Still verify in production:

- Web app behavior under strict CSP after game-client updates.
- Socket throughput and limit tuning with real traffic.

## 6) Runtime Validation

Before launch:

- Run server build cleanly.
- Run integration/security checks against production-like environment.
- Validate that non-allowed origins are rejected.
- Validate private/lobby/public data visibility boundaries.

## 7) Incident Readiness

- Enable and retain server logs for auth failures and rate-limit events.
- Define rotation/retention for logs.
- Prepare a rollback strategy for config and deployment changes.
- Document emergency token-secret rotation procedure.

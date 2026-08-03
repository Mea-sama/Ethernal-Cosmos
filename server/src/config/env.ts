export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function fail(message: string): never {
  throw new Error(message);
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    fail(`[Config] Ungültiger Wert für ${name}: ${value}`);
  }
  return parsed;
}

function parseOrigins(value: string | undefined): string[] {
  const devOrigins = [
    'http://localhost:12346',
    'https://localhost:12346',
    'http://127.0.0.1:12346',
    'https://127.0.0.1:12346',
  ];

  if (value === undefined || value.trim() === '') {
    if (IS_PRODUCTION) {
      fail('[Config] ALLOWED_ORIGINS muss in production gesetzt sein');
    }
    return devOrigins;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    fail('[Config] ALLOWED_ORIGINS darf nicht leer sein');
  }

  return origins;
}

function parseJwtSecret(value: string | undefined): string {
  if (value && value.trim().length > 0) {
    return value;
  }

  if (IS_PRODUCTION) {
    fail('[Config] JWT_SECRET muss in production gesetzt sein');
  }

  return 'dev-secret-change-in-production';
}

export const PORT = parseInteger(process.env.PORT, 12348, 'PORT');
export const HOST = process.env.HOST ?? '127.0.0.1';
export const JWT_SECRET = parseJwtSecret(process.env.JWT_SECRET);
export const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}
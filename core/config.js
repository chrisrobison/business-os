require('dotenv').config();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  port: toInt(process.env.PORT, 3010),
  modulesDir: process.env.MODULES_DIR || 'modules',
  appsDir: process.env.APPS_DIR || 'config/apps',
  defaultAppId: process.env.DEFAULT_APP_ID || 'default',
  tenancy: {
    strictHostMatch: String(process.env.TENANCY_STRICT_HOST_MATCH || 'true').toLowerCase() !== 'false',
    bootstrapHost: process.env.TENANCY_BOOTSTRAP_HOST || 'localhost',
    bootstrapDomain: process.env.TENANCY_BOOTSTRAP_DOMAIN || 'localhost',
    trustForwardedHost: String(process.env.TENANCY_TRUST_FORWARDED_HOST || 'false').toLowerCase() === 'true'
  },
  auth: {
    jwtSecret: process.env.AUTH_JWT_SECRET || '',
    tokenTtlSeconds: toInt(process.env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 8)
  },
  security: {
    trustProxy: process.env.TRUST_PROXY || 'false',
    corsAllowlist: parseCsv(process.env.CORS_ALLOWLIST),
    rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 300),
    apiBodyLimit: process.env.API_BODY_LIMIT || '1mb',
    authBodyLimit: process.env.AUTH_BODY_LIMIT || '32kb'
  },
  db: {
    client: (process.env.DB_CLIENT || 'mysql').toLowerCase(),
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'business_os',
    file: process.env.DB_FILE || ''
  },
  controlDb: {
    client: (process.env.CONTROL_DB_CLIENT || process.env.DB_CLIENT || 'sqlite').toLowerCase(),
    host: process.env.CONTROL_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.CONTROL_DB_PORT, toInt(process.env.DB_PORT, 3306)),
    user: process.env.CONTROL_DB_USER || process.env.DB_USER || 'root',
    password: process.env.CONTROL_DB_PASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.CONTROL_DB_NAME || 'business_os_control',
    file: process.env.CONTROL_DB_FILE || './data/business-os-control.sqlite'
  }
};

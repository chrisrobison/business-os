require('dotenv').config();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = {
  port: toInt(process.env.PORT, 3010),
  modulesDir: process.env.MODULES_DIR || 'modules',
  appsDir: process.env.APPS_DIR || 'config/apps',
  defaultAppId: process.env.DEFAULT_APP_ID || 'default',
  tenancy: {
    strictHostMatch: String(process.env.TENANCY_STRICT_HOST_MATCH || 'true').toLowerCase() !== 'false',
    bootstrapHost: process.env.TENANCY_BOOTSTRAP_HOST || 'localhost',
    bootstrapDomain: process.env.TENANCY_BOOTSTRAP_DOMAIN || 'localhost'
  },
  auth: {
    jwtSecret: process.env.AUTH_JWT_SECRET || '',
    tokenTtlSeconds: toInt(process.env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 8)
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

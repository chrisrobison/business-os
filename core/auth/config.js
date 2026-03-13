const crypto = require('crypto');
const { signJwt } = require('./jwt');

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function buildAuthConfig(env = process.env) {
  const jwtSecret = String(env.AUTH_JWT_SECRET || '').trim();
  const tokenTtlSeconds = toInt(env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 8);

  return {
    jwtSecret,
    tokenTtlSeconds,
    signToken(payload) {
      return signJwt(payload, jwtSecret, tokenTtlSeconds);
    }
  };
}

function validateAuthConfig(authConfig) {
  if (!authConfig.jwtSecret || authConfig.jwtSecret.length < 32) {
    const generated = crypto.randomBytes(32).toString('hex');
    throw new Error(`AUTH_JWT_SECRET must be set and at least 32 characters. Example: ${generated}`);
  }
}

module.exports = {
  buildAuthConfig,
  validateAuthConfig
};

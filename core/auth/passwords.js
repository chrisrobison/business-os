const crypto = require('crypto');

const DEFAULT_ITERATIONS = 120000;
const KEYLEN = 64;
const DIGEST = 'sha512';

function hashPassword(password) {
  const value = String(password || '');
  if (!value) {
    throw new Error('Password is required');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(value, salt, DEFAULT_ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${DIGEST}$${DEFAULT_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, encodedHash) {
  const value = String(password || '');
  const encoded = String(encodedHash || '');
  const parts = encoded.split('$');

  if (parts.length !== 5 || parts[0] !== 'pbkdf2') {
    return false;
  }

  const [, digest, iterationsRaw, salt, expectedHash] = parts;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!digest || !salt || !expectedHash || Number.isNaN(iterations) || iterations <= 0) {
    return false;
  }

  const actualHash = crypto.pbkdf2Sync(value, salt, iterations, Buffer.from(expectedHash, 'hex').length, digest).toString('hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const actualBuffer = Buffer.from(actualHash, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = {
  hashPassword,
  verifyPassword
};

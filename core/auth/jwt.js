const crypto = require('crypto');

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signJwt(payload, secret, expiresInSeconds) {
  if (!secret) {
    throw new Error('JWT secret is required');
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    ...payload,
    iat: now
  };

  if (expiresInSeconds && Number.isFinite(expiresInSeconds)) {
    tokenPayload.exp = now + Number(expiresInSeconds);
  }

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(tokenPayload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(unsignedToken)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${unsignedToken}.${signature}`;
}

function verifyJwt(token, secret) {
  if (!secret) {
    throw new Error('JWT secret is required');
  }

  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed token');
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(unsignedToken)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature || '');
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new Error('Invalid token signature');
  }

  const header = JSON.parse(fromBase64Url(encodedHeader));
  if (header.alg !== 'HS256') {
    throw new Error('Unsupported token algorithm');
  }

  const payload = JSON.parse(fromBase64Url(encodedPayload));
  if (payload.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) {
    throw new Error('Token expired');
  }

  return payload;
}

module.exports = {
  signJwt,
  verifyJwt
};

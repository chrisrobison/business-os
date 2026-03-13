const { uuid } = require('../utils');
const { createAuthStore, normalizeEmail } = require('./store');
const { hashPassword } = require('./passwords');
const { normalizeRole, ROLES } = require('./roles');

function splitName(fullName) {
  const value = String(fullName || '').trim();
  if (!value) {
    return { firstName: 'Owner', lastName: 'User' };
  }

  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }

  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts.slice(-1)[0]
  };
}

async function createOwnerUser(db, {
  tenantKey = 'default',
  email,
  password,
  fullName = 'Owner User',
  role = ROLES.OWNER
}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Valid email is required');
  }

  if (!password || String(password).length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const authStore = createAuthStore(db);
  await authStore.ensureSchema(tenantKey);

  const existingByEmail = await authStore.findByEmail(normalizedEmail, tenantKey);
  if (existingByEmail) {
    throw new Error(`Auth identity for '${normalizedEmail}' already exists`);
  }

  const existingUsers = await db.list('users', { limit: 500, offset: 0 });
  const existingUser = existingUsers.find((row) => String(row.email || '').toLowerCase() === normalizedEmail);
  const parsedName = splitName(fullName);

  let user = existingUser;
  if (!user) {
    user = await db.create('users', {
      id: uuid(),
      user: normalizedEmail.split('@')[0],
      first_name: parsedName.firstName,
      last_name: parsedName.lastName,
      email: normalizedEmail,
      role: normalizeRole(role, ROLES.OWNER),
      status: 'active'
    });
  } else {
    user = await db.update('users', user.id, {
      role: normalizeRole(role, ROLES.OWNER),
      status: 'active'
    }) || user;
  }

  const identity = await authStore.createIdentity({
    id: uuid(),
    userId: user.id,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    role: normalizeRole(role, ROLES.OWNER),
    status: 'active'
  }, tenantKey);

  return {
    user,
    identity
  };
}

module.exports = {
  createOwnerUser
};

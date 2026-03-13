const { normalizeRole, ROLES } = require('./roles');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createAuthStore(db) {
  const ensuredKeys = new Set();

  function getTableSql(client) {
    if (client === 'mysql') {
      return [
        `CREATE TABLE IF NOT EXISTS auth_identities (
          id CHAR(36) PRIMARY KEY,
          user_id CHAR(36) NOT NULL,
          email VARCHAR(255) NOT NULL,
          password_hash TEXT NOT NULL,
          role VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'active',
          created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY udx_auth_identities_user_id (user_id),
          UNIQUE KEY udx_auth_identities_email (email),
          KEY idx_auth_identities_role (role)
        ) ENGINE=InnoDB;`
      ];
    }

    if (client === 'postgres') {
      return [
        `CREATE TABLE IF NOT EXISTS auth_identities (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL UNIQUE,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          modified TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );`,
        'CREATE INDEX IF NOT EXISTS idx_auth_identities_role ON auth_identities(role);'
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS auth_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        modified TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      'CREATE INDEX IF NOT EXISTS idx_auth_identities_role ON auth_identities(role);'
    ];
  }

  async function ensureSchema(tenantKey = 'default') {
    if (ensuredKeys.has(tenantKey)) return;

    const statements = getTableSql(db.client);
    for (const sql of statements) {
      await db.query(sql);
    }

    ensuredKeys.add(tenantKey);
  }

  async function findByEmail(email, tenantKey = 'default') {
    await ensureSchema(tenantKey);
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    const rows = await db.query(
      'SELECT * FROM auth_identities WHERE email = ? LIMIT 1',
      [normalizedEmail]
    );

    return rows[0] || null;
  }

  async function findByUserId(userId, tenantKey = 'default') {
    await ensureSchema(tenantKey);
    const id = String(userId || '').trim();
    if (!id) return null;

    const rows = await db.query(
      'SELECT * FROM auth_identities WHERE user_id = ? LIMIT 1',
      [id]
    );

    return rows[0] || null;
  }

  async function createIdentity({ id, userId, email, passwordHash, role, status = 'active' }, tenantKey = 'default') {
    await ensureSchema(tenantKey);
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = normalizeRole(role, ROLES.VIEWER);

    await db.query(
      'INSERT INTO auth_identities (id, user_id, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      [id, String(userId || '').trim(), normalizedEmail, passwordHash, normalizedRole, String(status || 'active').trim() || 'active']
    );

    return findByUserId(userId, tenantKey);
  }

  return {
    ensureSchema,
    findByEmail,
    findByUserId,
    createIdentity,
    normalizeEmail
  };
}

module.exports = {
  createAuthStore,
  normalizeEmail
};

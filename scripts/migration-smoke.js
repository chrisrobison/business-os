const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { createDataSource } = require('../core/db');

async function runSqliteSmoke() {
  const file = path.join(os.tmpdir(), `business-os-migration-smoke-${process.pid}-${Date.now()}.sqlite`);
  const db = await createDataSource({ client: 'sqlite', file });
  try {
    await db.initSchema();
    const applied = await db.applyMigration(
      'smoke:sqlite:001',
      'CREATE TABLE IF NOT EXISTS smoke_sqlite (id TEXT PRIMARY KEY, value TEXT);'
    );
    if (!applied) {
      throw new Error('Expected sqlite migration to apply');
    }
    const appliedAgain = await db.applyMigration(
      'smoke:sqlite:001',
      'CREATE TABLE IF NOT EXISTS smoke_sqlite (id TEXT PRIMARY KEY, value TEXT);'
    );
    if (appliedAgain) {
      throw new Error('Expected sqlite migration key to be idempotent');
    }
    console.log('sqlite migration smoke: ok');
  } finally {
    await db.close();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function runPostgresSmoke() {
  const host = process.env.MIGRATION_PG_HOST || process.env.PGHOST || '127.0.0.1';
  const port = Number.parseInt(process.env.MIGRATION_PG_PORT || process.env.PGPORT || '5432', 10);
  const user = process.env.MIGRATION_PG_USER || process.env.PGUSER || 'postgres';
  const password = process.env.MIGRATION_PG_PASSWORD || process.env.PGPASSWORD || 'postgres';
  const adminDb = process.env.MIGRATION_PG_ADMIN_DB || 'postgres';
  const testDb = process.env.MIGRATION_PG_DB || `business_os_smoke_${Date.now()}`;

  const adminPool = new Pool({
    host,
    port,
    user,
    password,
    database: adminDb
  });

  let db;
  try {
    await adminPool.query(`CREATE DATABASE "${testDb}"`);
    db = await createDataSource({
      client: 'postgres',
      host,
      port,
      user,
      password,
      database: testDb
    });
    await db.initSchema();
    const applied = await db.applyMigration(
      'smoke:postgres:001',
      'CREATE TABLE IF NOT EXISTS smoke_postgres (id TEXT PRIMARY KEY, value TEXT);'
    );
    if (!applied) {
      throw new Error('Expected postgres migration to apply');
    }
    const appliedAgain = await db.applyMigration(
      'smoke:postgres:001',
      'CREATE TABLE IF NOT EXISTS smoke_postgres (id TEXT PRIMARY KEY, value TEXT);'
    );
    if (appliedAgain) {
      throw new Error('Expected postgres migration key to be idempotent');
    }
    console.log('postgres migration smoke: ok');
  } finally {
    if (db) {
      await db.close();
    }
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDb}"`);
    } catch {
      // ignore cleanup errors in smoke context
    }
    await adminPool.end();
  }
}

async function main() {
  await runSqliteSmoke();
  if (String(process.env.MIGRATION_SMOKE_POSTGRES || '').toLowerCase() === 'true') {
    await runPostgresSmoke();
  } else {
    console.log('postgres migration smoke: skipped');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

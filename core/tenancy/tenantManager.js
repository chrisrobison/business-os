const fs = require('fs');
const path = require('path');
const { createDataSource } = require('../db');
const { normalizeHost, normalizeDomain } = require('./controlStore');

function isIpAddress(hostname) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)
    || hostname.includes(':');
}

function deriveDomainFromHost(host) {
  const hostname = normalizeHost(host);
  if (!hostname) return '';
  if (hostname === 'localhost' || isIpAddress(hostname)) {
    return hostname;
  }

  const labels = hostname.split('.').filter(Boolean);
  if (labels.length <= 2) return hostname;
  return labels.slice(-2).join('.');
}

function extractRequestHost(req, options = {}) {
  const trustForwardedHost = options && options.trustForwardedHost === true;
  const forwarded = trustForwardedHost
    ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    : '';
  const rawHost = forwarded || String(req.headers.host || '');
  return normalizeHost(rawHost);
}

async function applyModuleMigrations(db, modulesDir) {
  const absoluteModulesDir = path.resolve(process.cwd(), modulesDir);
  if (!fs.existsSync(absoluteModulesDir)) {
    return;
  }

  const moduleDirs = fs.readdirSync(absoluteModulesDir)
    .map((name) => path.join(absoluteModulesDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory());

  for (const moduleDir of moduleDirs) {
    const manifestPath = path.join(moduleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const moduleName = manifest.name || path.basename(moduleDir);
    const migrationsDir = path.join(moduleDir, 'migrations');
    if (!fs.existsSync(migrationsDir)) continue;

    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const migrationKey = `${moduleName}:${file}`;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await db.applyMigration(migrationKey, sql);
    }
  }
}

function createScopedDbProxy(getActiveDb) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      const db = getActiveDb();
      const value = db[prop];
      if (typeof value === 'function') {
        return (...args) => value.apply(db, args);
      }
      return value;
    }
  });
}

function buildTenantDbConfig(instance) {
  const dbConfig = instance.db_config || {};
  const client = String(instance.db_client || dbConfig.client || '').trim().toLowerCase();

  if (!client) {
    throw new Error(`Instance '${instance.id}' is missing db_client`);
  }

  return {
    client,
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    file: dbConfig.file
  };
}

function getInstanceRevision(instance) {
  return [
    instance.updated_at || '',
    instance.db_client || '',
    instance.db_config_json || ''
  ].join('|');
}

function createTenantManager({ controlStore, modulesDir }) {
  const cache = new Map();

  async function buildTenantRuntime(instance) {
    const dbConfig = buildTenantDbConfig(instance);
    const db = await createDataSource(dbConfig);
    await db.initSchema();
    await applyModuleMigrations(db, modulesDir);

    return {
      instance,
      revision: getInstanceRevision(instance),
      db
    };
  }

  async function getOrCreateTenantRuntime(instance) {
    const cacheKey = instance.id;
    const currentRevision = getInstanceRevision(instance);
    const existing = cache.get(cacheKey);

    if (existing && existing.revision === currentRevision) {
      return existing;
    }

    if (existing) {
      await existing.db.close();
      cache.delete(cacheKey);
    }

    const runtime = await buildTenantRuntime(instance);
    cache.set(cacheKey, runtime);
    return runtime;
  }

  async function resolveTenantForHost(host, domainOverride = null) {
    const normalizedHost = normalizeHost(host);
    const normalizedDomain = normalizeDomain(domainOverride || deriveDomainFromHost(normalizedHost));

    if (!normalizedHost || !normalizedDomain) {
      return null;
    }

    const instance = await controlStore.resolveByHostAndDomain(normalizedHost, normalizedDomain);
    if (!instance) {
      return null;
    }

    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: normalizedHost,
      domain: normalizedDomain,
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function getDefaultTenant() {
    const instance = await controlStore.getDefaultInstance();
    if (!instance) return null;
    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: null,
      domain: null,
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function ensureBootstrapTenant({ host, domain, dbClient, dbConfig }) {
    const instance = await controlStore.ensureBootstrapTenant({ host, domain, dbClient, dbConfig });
    if (!instance) return null;
    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: normalizeHost(host),
      domain: normalizeDomain(domain),
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function closeAll() {
    const runtimes = Array.from(cache.values());
    cache.clear();
    await Promise.all(runtimes.map((runtime) => runtime.db.close().catch(() => null)));
  }

  function invalidateInstance(instanceId) {
    const existing = cache.get(instanceId);
    if (!existing) return;
    cache.delete(instanceId);
    existing.db.close().catch(() => null);
  }

  function invalidateAll() {
    const runtimes = Array.from(cache.values());
    cache.clear();
    for (const runtime of runtimes) {
      runtime.db.close().catch(() => null);
    }
  }

  return {
    extractRequestHost,
    deriveDomainFromHost,
    createScopedDbProxy,
    resolveTenantForHost,
    ensureBootstrapTenant,
    getDefaultTenant,
    closeAll,
    invalidateInstance,
    invalidateAll
  };
}

module.exports = {
  createTenantManager,
  deriveDomainFromHost,
  extractRequestHost,
  createScopedDbProxy
};

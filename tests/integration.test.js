const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOwnerUser } = require('../core/auth/bootstrap');

function tempFile(name) {
  return path.join(os.tmpdir(), `business-os-${process.pid}-${Date.now()}-${name}.sqlite`);
}

function purgeCoreRequireCache() {
  const root = `${path.sep}core${path.sep}`;
  for (const cacheKey of Object.keys(require.cache)) {
    if (cacheKey.includes(root)) {
      delete require.cache[cacheKey];
    }
  }
}

async function jsonRequest(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

test('integration: auth, tenancy, IDs, module migrations', async (t) => {
  const tenantDbFile = tempFile('tenant');
  const controlDbFile = tempFile('control');
  const host = 'tenant.test.local';

  process.env.PORT = '0';
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_FILE = tenantDbFile;
  process.env.CONTROL_DB_CLIENT = 'sqlite';
  process.env.CONTROL_DB_FILE = controlDbFile;
  process.env.TENANCY_STRICT_HOST_MATCH = 'true';
  process.env.TENANCY_BOOTSTRAP_HOST = host;
  process.env.TENANCY_BOOTSTRAP_DOMAIN = 'test.local';
  process.env.AUTH_JWT_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.CORS_ALLOWLIST = '';
  process.env.TRUST_PROXY = 'false';
  process.env.TENANCY_TRUST_FORWARDED_HOST = 'true';

  purgeCoreRequireCache();
  const { buildServer } = require('../core/server');
  const runtime = await buildServer();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

  t.after(async () => {
    await runtime.shutdown({ exitProcess: false });
    if (fs.existsSync(tenantDbFile)) fs.unlinkSync(tenantDbFile);
    if (fs.existsSync(controlDbFile)) fs.unlinkSync(controlDbFile);
  });

  await createOwnerUser(runtime.db, {
    tenantKey: 'default',
    email: 'owner@example.com',
    password: 'password123',
    fullName: 'Owner User',
    role: 'owner'
  });
  await createOwnerUser(runtime.db, {
    tenantKey: 'default',
    email: 'viewer@example.com',
    password: 'password123',
    fullName: 'Viewer User',
    role: 'viewer'
  });

  {
    const { response } = await jsonRequest(baseUrl, '/api/system', {
      headers: { 'x-forwarded-host': 'unknown.example.com' }
    });
    assert.equal(response.status, 404);
  }

  const loginOwner = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      email: 'owner@example.com',
      password: 'password123'
    })
  });
  assert.equal(loginOwner.response.status, 200);
  const ownerToken = loginOwner.body.token;
  assert.ok(ownerToken);

  const loginViewer = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      email: 'viewer@example.com',
      password: 'password123'
    })
  });
  assert.equal(loginViewer.response.status, 200);
  const viewerToken = loginViewer.body.token;
  assert.ok(viewerToken);

  {
    const createDenied = await jsonRequest(baseUrl, '/api/customers', {
      method: 'POST',
      headers: {
        'x-forwarded-host': host,
        Authorization: `Bearer ${viewerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        customer: 'Denied Viewer',
        status: 'active'
      })
    });
    assert.equal(createDenied.response.status, 403);
  }

  const createCustomer = await jsonRequest(baseUrl, '/api/customers', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      Authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      customer: 'Acme Client',
      status: 'active'
    })
  });
  assert.equal(createCustomer.response.status, 201);
  assert.ok(createCustomer.body.id);
  assert.ok(createCustomer.body.public_id);

  {
    const byUuid = await jsonRequest(baseUrl, `/api/customers/${createCustomer.body.id}`, {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(byUuid.response.status, 200);
    assert.equal(byUuid.body.id, createCustomer.body.id);
  }

  {
    const byPublicId = await jsonRequest(baseUrl, `/api/customers/${createCustomer.body.public_id}`, {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(byPublicId.response.status, 200);
    assert.equal(byPublicId.body.public_id, createCustomer.body.public_id);
  }

  {
    const modules = await jsonRequest(baseUrl, '/api/system/modules', {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(modules.response.status, 200);
    const salon = (modules.body.data.modules || []).find((item) => item.name === 'salon-module');
    assert.ok(salon);
    assert.equal(salon.status, 'loaded');
    assert.ok(Array.isArray(salon.migrationsApplied));
  }
});

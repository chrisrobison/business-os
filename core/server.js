const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const EventBus = require('./eventBus');
const createEntityRouter = require('./router');
const { loadPlugins } = require('./pluginLoader');
const { loadAppDefinition, listAppIds } = require('./appDefinitions');
const { createControlStore } = require('./tenancy/controlStore');
const { createTenantManager } = require('./tenancy/tenantManager');
const { runWithRequestContext, getRequestContext } = require('./requestContext');
const { createAuthMiddleware } = require('./auth/middleware');
const { buildAuthConfig, validateAuthConfig } = require('./auth/config');
const { createMetricsRegistry, createRequestTelemetry } = require('./observability');
const { assertAllowedKeys, validateIdentifier } = require('./validation');

const serverHookRegistry = {
  'server.auditView': async ({ req, appId, navItemId, context, options }) => ({
    ok: true,
    hook: 'server.auditView',
    appId,
    navItemId,
    actor: req.auth ? req.auth.userId : (req.headers['x-business-user'] || 'anonymous'),
    area: options?.area || navItemId || null,
    event: context?.event || null,
    at: new Date().toISOString()
  }),
  'server.auditSave': async ({ req, appId, navItemId, context, options }) => ({
    ok: true,
    hook: 'server.auditSave',
    appId,
    navItemId,
    actor: req.auth ? req.auth.userId : (req.headers['x-business-user'] || 'anonymous'),
    area: options?.area || navItemId || null,
    event: context?.event || null,
    at: new Date().toISOString()
  })
};

async function buildServer() {
  const app = express();
  const sendEnvelope = (res, data) => res.json({ version: 'v1', data });
  const trustProxySetting = config.security.trustProxy;
  app.set('trust proxy', trustProxySetting === 'false' ? false : trustProxySetting);

  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(cors({
    origin(origin, callback) {
      const allowlist = config.security.corsAllowlist;
      if (!origin || allowlist.length === 0 || allowlist.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS policy'));
    }
  }));
  app.use('/api/auth/login', express.json({ limit: config.security.authBodyLimit }));
  app.use('/api', express.json({ limit: config.security.apiBodyLimit }));

  const metrics = createMetricsRegistry();
  app.use(createRequestTelemetry({
    getContext: getRequestContext,
    metrics
  }));

  app.use('/api', rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false
  }));
  const authConfig = buildAuthConfig(process.env);
  validateAuthConfig(authConfig);

  const controlStore = await createControlStore(config.controlDb);
  await controlStore.initSchema();

  const tenantManager = createTenantManager({
    controlStore,
    modulesDir: config.modulesDir
  });

  await tenantManager.ensureBootstrapTenant({
    host: config.tenancy.bootstrapHost,
    domain: config.tenancy.bootstrapDomain,
    dbClient: config.db.client,
    dbConfig: config.db
  });

  let defaultTenant = await tenantManager.getDefaultTenant();
  if (!defaultTenant) {
    throw new Error('No active tenant instances found. Add at least one instance and domain mapping.');
  }

  async function refreshDefaultTenant() {
    const latestDefault = await tenantManager.getDefaultTenant();
    if (latestDefault) {
      defaultTenant = latestDefault;
    }
    return defaultTenant;
  }

  function getActiveContext() {
    return getRequestContext() || defaultTenant;
  }

  const db = tenantManager.createScopedDbProxy(() => {
    const context = getActiveContext();
    if (!context || !context.db) {
      throw new Error('No tenant DB is available for this operation');
    }
    return context.db;
  });

  const eventBus = new EventBus({
    persistEvent: async (eventName, payload) => {
      const context = getActiveContext();
      await context.db.appendEvent(eventName, payload);
    }
  });

  app.use(async (req, res, next) => {
    const requestPath = req.path || '';
    const isControlPlane = requestPath === '/health'
      || requestPath === '/ready'
      || requestPath.startsWith('/admin');

    if (isControlPlane) {
      return next();
    }

    try {
      const host = tenantManager.extractRequestHost(req, {
        trustForwardedHost: config.tenancy.trustForwardedHost
      });
      if (!host) {
        console.warn(JSON.stringify({
          level: 'warn',
          at: new Date().toISOString(),
          type: 'tenancy_resolution_missing_host',
          requestId: req.requestId || null,
          path: req.path
        }));
      }
      const tenant = await tenantManager.resolveTenantForHost(host);

      if (!tenant && config.tenancy.strictHostMatch) {
        console.warn(JSON.stringify({
          level: 'warn',
          at: new Date().toISOString(),
          type: 'tenancy_resolution_miss',
          requestId: req.requestId || null,
          host,
          path: req.path
        }));
        if (requestPath.startsWith('/api/')) {
          return res.status(404).json({ error: `No tenant mapping for host '${host}'` });
        }
        return res.status(404).send(`No tenant mapping for host '${host}'`);
      }

      if (!tenant && !config.tenancy.strictHostMatch && requestPath.startsWith('/api/')) {
        console.warn(JSON.stringify({
          level: 'warn',
          at: new Date().toISOString(),
          type: 'tenancy_resolution_fallback_default',
          requestId: req.requestId || null,
          host,
          path: req.path,
          defaultTenantId: defaultTenant.instance.id
        }));
      }

      const context = tenant || defaultTenant;
      return runWithRequestContext(context, () => next());
    } catch (error) {
      return next(error);
    }
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      controlDbClient: controlStore.client,
      defaultTenantId: defaultTenant.instance.id,
      time: new Date().toISOString()
    });
  });

  app.get('/ready', async (req, res) => {
    try {
      await controlStore.listInstances();
      await defaultTenant.db.query('SELECT 1 AS ok');
      res.json({
        ok: true,
        controlDb: true,
        tenantDb: true,
        defaultTenantId: defaultTenant.instance.id,
        time: new Date().toISOString()
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message || 'readiness check failed',
        time: new Date().toISOString()
      });
    }
  });

  app.get('/', (req, res) => {
    res.redirect('/app');
  });

  const auth = createAuthMiddleware({ db, authConfig });

  app.post('/api/auth/login', auth.loginHandler);
  app.use('/api', auth.authenticateRequest({ allowAnonymousPaths: ['/auth/login'] }));
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.auth || null });
  });

  app.use('/api', createEntityRouter(db, eventBus, {
    requireEntityMutationRole: auth.requireEntityMutationRole
  }));

  const { modules, scheduler } = await loadPlugins({
    app,
    db,
    eventBus,
    modulesDir: config.modulesDir
  });

  app.get('/api/system/modules', (req, res) => {
    sendEnvelope(res, { modules, jobs: scheduler.listJobs() });
  });

  app.get('/api/system/metrics', (req, res) => {
    sendEnvelope(res, {
      generatedAt: new Date().toISOString(),
      routes: metrics.snapshot()
    });
  });

  app.get('/api/system', (req, res) => {
    const context = getActiveContext();
    sendEnvelope(res, {
      app: 'business-os',
      version: '0.1.0',
      dbClient: db.client,
      tenantId: context.instance.id,
      modulesLoaded: modules.length,
      modules: modules.map((m) => ({
        name: m.name,
        version: m.version,
        slug: m.slug,
        description: m.description
      }))
    });
  });

  app.get('/api/apps', async (req, res, next) => {
    try {
      const appIds = await listAppIds(config.appsDir);
      res.json({
        defaultAppId: config.defaultAppId,
        apps: appIds
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/apps/:appId', async (req, res, next) => {
    try {
      const appDefinition = await loadAppDefinition(config.appsDir, req.params.appId);
      res.json(appDefinition);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: `Unknown app '${req.params.appId}'` });
      }
      if (error.message && error.message.startsWith('Invalid app id')) {
        return res.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  app.post('/api/apps/:appId/hooks/:hookName', async (req, res, next) => {
    try {
      await loadAppDefinition(config.appsDir, req.params.appId);
      const hookFn = serverHookRegistry[req.params.hookName];
      if (!hookFn) {
        return res.status(404).json({ error: `Unknown server hook '${req.params.hookName}'` });
      }

      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['navItemId', 'context', 'options']), 'apps hook payload');
      const result = await hookFn({
        req,
        appId: req.params.appId,
        navItemId: payload.navItemId || null,
        context: payload.context || {},
        options: payload.options || {}
      });
      return res.json({ ok: true, result });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: `Unknown app '${req.params.appId}'` });
      }
      if (error.message && error.message.startsWith('Invalid app id')) {
        return res.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  app.use('/api/admin/tenancy', auth.requireRoles(['owner', 'admin']));

  app.get('/api/admin/tenancy/summary', async (req, res, next) => {
    try {
      const [customers, instances, domains] = await Promise.all([
        controlStore.listCustomers(),
        controlStore.listInstances(),
        controlStore.listDomains()
      ]);
      sendEnvelope(res, {
        customers,
        instances,
        domains
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/tenancy/customers', async (req, res, next) => {
    try {
      sendEnvelope(res, await controlStore.listCustomers());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/tenancy/customers', async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['id', 'name', 'status', 'metadata']), 'customer payload');
      const customer = await controlStore.createCustomer(payload);
      res.status(201).json({ version: 'v1', data: customer });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/tenancy/customers/:customerId', async (req, res, next) => {
    try {
      const customerId = validateIdentifier(req.params.customerId, 'customerId');
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['name', 'status', 'metadata']), 'customer payload');
      const customer = await controlStore.updateCustomer(customerId, payload);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      return sendEnvelope(res, customer);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/tenancy/instances', async (req, res, next) => {
    try {
      sendEnvelope(res, await controlStore.listInstances());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/tenancy/instances', async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['id', 'customer_id', 'name', 'status', 'is_default', 'db_client', 'db_config', 'app_config']), 'instance payload');
      const instance = await controlStore.createInstance(payload);
      tenantManager.invalidateAll();
      await refreshDefaultTenant();
      res.status(201).json({ version: 'v1', data: instance });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/tenancy/instances/:instanceId', async (req, res, next) => {
    try {
      const instanceId = validateIdentifier(req.params.instanceId, 'instanceId');
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['customer_id', 'name', 'status', 'is_default', 'db_client', 'db_config', 'app_config']), 'instance payload');
      const instance = await controlStore.updateInstance(instanceId, payload);
      if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
      }
      tenantManager.invalidateInstance(instance.id);
      await refreshDefaultTenant();
      return sendEnvelope(res, instance);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/tenancy/domains', async (req, res, next) => {
    try {
      sendEnvelope(res, await controlStore.listDomains());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/tenancy/domains', async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['id', 'instance_id', 'host', 'domain', 'status']), 'domain payload');
      const domain = await controlStore.createDomain(payload);
      tenantManager.invalidateAll();
      await refreshDefaultTenant();
      res.status(201).json({ version: 'v1', data: domain });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/tenancy/domains/:domainId', async (req, res, next) => {
    try {
      const domainId = validateIdentifier(req.params.domainId, 'domainId');
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['instance_id', 'host', 'domain', 'status']), 'domain payload');
      const domain = await controlStore.updateDomain(domainId, payload);
      if (!domain) {
        return res.status(404).json({ error: 'Domain mapping not found' });
      }
      tenantManager.invalidateAll();
      await refreshDefaultTenant();
      return sendEnvelope(res, domain);
    } catch (error) {
      return next(error);
    }
  });

  app.use('/dashboard', express.static(path.join(process.cwd(), 'ui', 'dashboard')));
  app.use('/admin', express.static(path.join(process.cwd(), 'ui', 'admin')));
  app.use('/app', express.static(path.join(process.cwd(), 'ui', 'app')));
  app.use('/modules', express.static(path.join(process.cwd(), 'modules')));

  app.use((err, req, res, next) => {
    const statusCode = Number(err && err.statusCode) || 500;
    console.error(JSON.stringify({
      level: 'error',
      at: new Date().toISOString(),
      type: 'http_error',
      requestId: req.requestId || null,
      method: req.method,
      path: req.path,
      statusCode,
      message: err && err.message ? err.message : 'Internal server error'
    }));
    res.status(statusCode).json({
      error: err.message || 'Internal server error',
      details: err.details || null,
      requestId: req.requestId || null
    });
  });

  const server = app.listen(config.port, () => {
    console.log(`Business OS listening on http://localhost:${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}/dashboard`);
    console.log(`Tenancy admin: http://localhost:${config.port}/admin`);
    console.log(`User app runtime: http://localhost:${config.port}/app`);
    console.log(`Control DB connector: ${controlStore.client}`);
    console.log(`Loaded modules: ${modules.map((m) => m.name).join(', ') || '(none)'}`);
  });

  const shutdown = async ({ exitProcess = true } = {}) => {
    scheduler.stopAll();
    await tenantManager.closeAll();
    await controlStore.close();
    await new Promise((resolve) => server.close(resolve));
    if (exitProcess) {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown({ exitProcess: true }));
  process.on('SIGTERM', () => shutdown({ exitProcess: true }));

  return { app, server, db, eventBus, modules, controlStore, shutdown, scheduler };
}

if (require.main === module) {
  buildServer().catch((error) => {
    console.error('Failed to start Business OS:', error);
    process.exit(1);
  });
}

module.exports = { buildServer };

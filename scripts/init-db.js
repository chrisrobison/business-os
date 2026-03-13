const config = require('../core/config');
const { createDataSource } = require('../core/db');
const { createControlStore } = require('../core/tenancy/controlStore');
const { createAuthStore } = require('../core/auth/store');

(async () => {
  const controlStore = await createControlStore(config.controlDb);
  await controlStore.initSchema();

  const tenantDb = await createDataSource(config.db);
  await tenantDb.initSchema();
  await createAuthStore(tenantDb).ensureSchema('default');

  await controlStore.ensureBootstrapTenant({
    host: config.tenancy.bootstrapHost,
    domain: config.tenancy.bootstrapDomain,
    dbClient: config.db.client,
    dbConfig: config.db
  });

  console.log(`Initialized control schema using ${controlStore.client}`);
  console.log(`Initialized tenant schema using ${tenantDb.client}`);

  await tenantDb.close();
  await controlStore.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

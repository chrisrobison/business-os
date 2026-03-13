const config = require('../core/config');
const { createDataSource } = require('../core/db');
const { createOwnerUser } = require('../core/auth/bootstrap');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || process.env.BOOTSTRAP_OWNER_EMAIL || '').trim();
  const password = String(args.password || process.env.BOOTSTRAP_OWNER_PASSWORD || '');
  const name = String(args.name || process.env.BOOTSTRAP_OWNER_NAME || 'Owner User').trim();

  if (!email || !password) {
    console.error('Usage: node scripts/create-owner-user.js --email owner@example.com --password <secret> [--name "Owner User"]');
    process.exit(1);
  }

  const db = await createDataSource(config.db);
  await db.initSchema();

  try {
    const created = await createOwnerUser(db, {
      tenantKey: process.env.TENANT_ID || 'default',
      email,
      password,
      fullName: name,
      role: 'owner'
    });

    console.log('Created owner identity successfully');
    console.log(`tenant: ${process.env.TENANT_ID || 'default'}`);
    console.log(`user_id: ${created.user.id}`);
    console.log(`email: ${created.identity.email}`);
    console.log(`role: ${created.identity.role}`);
  } finally {
    await db.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

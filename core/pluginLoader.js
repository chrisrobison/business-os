const fs = require('fs');
const path = require('path');
const express = require('express');
const entities = require('./entities');

function createJobScheduler() {
  const jobs = [];

  return {
    addJob(name, handler, intervalMs) {
      if (!intervalMs || intervalMs < 1000) {
        throw new Error(`Invalid interval for job '${name}'`);
      }
      const id = setInterval(async () => {
        try {
          await handler();
        } catch (error) {
          console.error(`[job:${name}]`, error.message);
        }
      }, intervalMs);

      jobs.push({ name, id, intervalMs });
      return () => clearInterval(id);
    },
    listJobs() {
      return jobs.map(({ id, ...rest }) => rest);
    },
    stopAll() {
      for (const job of jobs) {
        clearInterval(job.id);
      }
    }
  };
}

function resolveIfExists(filePath) {
  return fs.existsSync(filePath) ? filePath : null;
}

function ensureStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeManifestPermissions(manifest) {
  const raw = manifest && manifest.permissions ? manifest.permissions : {};
  const knownEntities = new Set(entities);
  const entityList = ensureStringArray(raw.entities || [], 'manifest.permissions.entities');
  for (const entity of entityList) {
    if (!knownEntities.has(entity)) {
      throw new Error(`Unknown entity permission '${entity}'`);
    }
  }

  const events = raw.events || {};
  const publish = ensureStringArray(events.publish || [], 'manifest.permissions.events.publish');
  const subscribe = ensureStringArray(events.subscribe || [], 'manifest.permissions.events.subscribe');

  return {
    entities: new Set(entityList),
    events: {
      publish: new Set(publish),
      subscribe: new Set(subscribe)
    },
    routes: raw.routes !== false,
    jobs: raw.jobs !== false
  };
}

function createModuleDbProxy(db, permissions, moduleName) {
  const guardedMethods = new Set([
    'create',
    'getById',
    'getByPublicId',
    'getByIdentifier',
    'resolveId',
    'list',
    'listByFilters',
    'count',
    'update',
    'remove',
    'describe',
    'refreshSchema'
  ]);

  return new Proxy(db, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function' || !guardedMethods.has(String(prop))) {
        return value;
      }
      return (...args) => {
        const entity = String(args[0] || '').trim();
        if (!permissions.entities.has(entity)) {
          throw new Error(`[${moduleName}] entity '${entity}' not declared in manifest permissions`);
        }
        return value.apply(target, args);
      };
    }
  });
}

function createModuleEventBusProxy(eventBus, permissions, moduleName) {
  return {
    subscribe(eventName, handler) {
      const normalized = String(eventName || '').trim();
      if (!permissions.events.subscribe.has(normalized) && !permissions.events.subscribe.has('*')) {
        throw new Error(`[${moduleName}] event subscribe '${normalized}' not declared in manifest permissions`);
      }
      return eventBus.subscribe(normalized, handler);
    },
    publish(eventName, payload = {}) {
      const normalized = String(eventName || '').trim();
      if (!permissions.events.publish.has(normalized) && !permissions.events.publish.has('*')) {
        throw new Error(`[${moduleName}] event publish '${normalized}' not declared in manifest permissions`);
      }
      return eventBus.publish(normalized, payload);
    }
  };
}

function createModuleSchedulerProxy(scheduler, permissions, moduleName) {
  return {
    addJob(name, handler, intervalMs) {
      if (!permissions.jobs) {
        throw new Error(`[${moduleName}] jobs capability not enabled in manifest permissions`);
      }
      return scheduler.addJob(name, handler, intervalMs);
    },
    listJobs() {
      return scheduler.listJobs();
    },
    stopAll() {
      return scheduler.stopAll();
    }
  };
}

async function loadModuleMigrations(db, moduleDir, moduleName) {
  const migrationsDir = path.join(moduleDir, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const applied = [];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const migrationKey = `${moduleName}:${file}`;
    const didApply = await db.applyMigration(migrationKey, sql);
    if (didApply) {
      applied.push(file);
    }
  }

  return applied;
}

function loadPanelDefinitions(moduleDir) {
  const panelJson = resolveIfExists(path.join(moduleDir, 'ui', 'panel.json'));
  if (!panelJson) {
    return [];
  }

  try {
    const panel = JSON.parse(fs.readFileSync(panelJson, 'utf8'));
    return Array.isArray(panel) ? panel : [panel];
  } catch (error) {
    console.warn(`[pluginLoader] Failed to parse panel.json: ${error.message}`);
    return [];
  }
}

async function loadPlugins({ app, db, eventBus, modulesDir }) {
  const scheduler = createJobScheduler();
  const absoluteModulesDir = path.resolve(process.cwd(), modulesDir);

  if (!fs.existsSync(absoluteModulesDir)) {
    return { modules: [], scheduler };
  }

  const moduleDirs = fs.readdirSync(absoluteModulesDir)
    .map((name) => path.join(absoluteModulesDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory());

  const loadedModules = [];

  for (const moduleDir of moduleDirs) {
    const manifestPath = path.join(moduleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const moduleName = manifest.name || path.basename(moduleDir);
      const moduleSlug = moduleName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const permissions = normalizeManifestPermissions(manifest);
      const panelDefs = loadPanelDefinitions(moduleDir);
      const migrations = await loadModuleMigrations(db, moduleDir, moduleName);

      const moduleContext = {
        app,
        db: createModuleDbProxy(db, permissions, moduleName),
        eventBus: createModuleEventBusProxy(eventBus, permissions, moduleName),
        scheduler: createModuleSchedulerProxy(scheduler, permissions, moduleName),
        module: manifest,
        moduleDir,
        logger: {
          info: (...args) => console.log(`[${moduleName}]`, ...args),
          warn: (...args) => console.warn(`[${moduleName}]`, ...args),
          error: (...args) => console.error(`[${moduleName}]`, ...args)
        }
      };

      const routesPath = resolveIfExists(path.join(moduleDir, 'routes.js'));
      if (routesPath) {
        if (!permissions.routes) {
          throw new Error('routes.js found but manifest.permissions.routes is disabled');
        }
        const router = express.Router();
        const registerRoutes = require(routesPath);
        if (typeof registerRoutes === 'function') {
          await registerRoutes(router, moduleContext);
        }
        app.use(`/api/modules/${moduleSlug}`, router);
      }

      const eventsPath = resolveIfExists(path.join(moduleDir, 'events.js'));
      if (eventsPath) {
        const registerEvents = require(eventsPath);
        if (typeof registerEvents === 'function') {
          await registerEvents(moduleContext);
        }
      }

      const jobsPath = resolveIfExists(path.join(moduleDir, 'jobs.js'));
      if (jobsPath) {
        if (!permissions.jobs) {
          throw new Error('jobs.js found but manifest.permissions.jobs is disabled');
        }
        const registerJobs = require(jobsPath);
        if (typeof registerJobs === 'function') {
          await registerJobs(moduleContext);
        }
      }

      loadedModules.push({
        ...manifest,
        slug: moduleSlug,
        status: 'loaded',
        migrationsApplied: migrations,
        panels: panelDefs
      });
    } catch (error) {
      const moduleName = (manifest && manifest.name) || path.basename(moduleDir);
      console.error(`[pluginLoader] Failed to load module '${moduleName}': ${error.message}`);
      loadedModules.push({
        name: moduleName,
        version: manifest && manifest.version ? manifest.version : 'unknown',
        slug: moduleName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        status: 'failed',
        error: error.message
      });
    }
  }

  return { modules: loadedModules, scheduler };
}

module.exports = { loadPlugins };

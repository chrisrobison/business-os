const express = require('express');
const entities = require('./entities');
const {
  parsePositiveInt,
  validateEntityPayload,
  validateIdentifier,
  badRequest
} = require('./validation');

function createEntityRouter(db, eventBus, options = {}) {
  const router = express.Router();
  const entitySet = new Set(entities);
  const requireEntityMutationRole = typeof options.requireEntityMutationRole === 'function'
    ? options.requireEntityMutationRole
    : ((_req, _res, next) => next());

  for (const entity of entities) {
    router.post(`/${entity}`, requireEntityMutationRole, async (req, res, next) => {
      try {
        validateEntityPayload(entity, req.body || {}, { partial: false });
        const created = await db.create(entity, req.body || {});
        await eventBus.publish(`${entity.slice(0, -1)}.created`, {
          entity,
          id: created.id,
          public_id: created.public_id || null,
          record: created
        });
        res.status(201).json(created);
      } catch (error) {
        next(error);
      }
    });

    router.get(`/${entity}`, async (req, res, next) => {
      try {
        const { q } = req.query;
        const limit = parsePositiveInt(req.query.limit, 25, { min: 1, max: 200 });
        const offset = parsePositiveInt(req.query.offset, 0, { min: 0, max: 5000 });
        const rows = await db.list(entity, {
          q,
          limit,
          offset
        });
        res.json(rows);
      } catch (error) {
        next(error);
      }
    });

    router.get(`/${entity}/:identifier`, async (req, res, next) => {
      try {
        const identifier = validateIdentifier(req.params.identifier);
        const row = await db.getByIdentifier(entity, identifier);
        if (!row) {
          return res.status(404).json({ error: `${entity} record not found` });
        }
        return res.json(row);
      } catch (error) {
        return next(error);
      }
    });

    router.put(`/${entity}/:identifier`, requireEntityMutationRole, async (req, res, next) => {
      try {
        const identifier = validateIdentifier(req.params.identifier);
        validateEntityPayload(entity, req.body || {}, { partial: true });
        const updated = await db.update(entity, identifier, req.body || {});
        if (!updated) {
          return res.status(404).json({ error: `${entity} record not found` });
        }

        await eventBus.publish(`${entity.slice(0, -1)}.updated`, {
          entity,
          id: updated.id,
          public_id: updated.public_id || null,
          record: updated
        });
        return res.json(updated);
      } catch (error) {
        return next(error);
      }
    });

    router.delete(`/${entity}/:identifier`, requireEntityMutationRole, async (req, res, next) => {
      try {
        const identifier = validateIdentifier(req.params.identifier);
        const existing = await db.getByIdentifier(entity, identifier);
        if (!existing) {
          return res.status(404).json({ error: `${entity} record not found` });
        }

        const deleted = await db.remove(entity, existing.id);
        if (!deleted) {
          return res.status(404).json({ error: `${entity} record not found` });
        }

        await eventBus.publish(`${entity.slice(0, -1)}.deleted`, {
          entity,
          id: existing.id,
          public_id: existing.public_id || null
        });
        return res.status(204).send();
      } catch (error) {
        return next(error);
      }
    });

    router.get(`/${entity}/resolve/:identifier`, async (req, res, next) => {
      try {
        const identifier = validateIdentifier(req.params.identifier);
        const row = await db.getByIdentifier(entity, identifier);
        if (!row) {
          return res.status(404).json({ error: `${entity} record not found` });
        }
        return res.json(row);
      } catch (error) {
        return next(error);
      }
    });
  }

  router.get('/events', async (req, res, next) => {
    try {
      const limit = parsePositiveInt(req.query.limit, 100, { min: 1, max: 500 });
      const items = await db.listEvents(limit);
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  router.get('/analytics', async (req, res, next) => {
    try {
      const counts = {};
      await Promise.all(
        entities.map(async (entity) => {
          counts[entity] = await db.count(entity);
        })
      );
      res.json({
        generatedAt: new Date().toISOString(),
        entityCounts: counts
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/schema/:entity', async (req, res, next) => {
    try {
      const schema = await db.describe(req.params.entity);
      res.json({ entity: req.params.entity, columns: schema });
    } catch (error) {
      if (error.message && error.message.startsWith('Unknown entity')) {
        return res.status(404).json({ error: error.message });
      }
      return next(error);
    }
  });

  async function createClampLink(req, res, next) {
    try {
      const { local, local_id, remote, remote_id, context } = req.body || {};
      if (!local || !local_id || !remote || !remote_id) {
        return res.status(400).json({ error: 'local, local_id, remote, and remote_id are required' });
      }
      if (!entitySet.has(local) || !entitySet.has(remote)) {
        return res.status(400).json({ error: 'local and remote must be valid table names' });
      }

      const resolvedLocalId = await db.resolveId(local, local_id);
      if (!resolvedLocalId) {
        return res.status(400).json({ error: `Local record '${local_id}' not found in ${local}` });
      }

      const resolvedRemoteId = await db.resolveId(remote, remote_id);
      if (!resolvedRemoteId) {
        return res.status(400).json({ error: `Remote record '${remote_id}' not found in ${remote}` });
      }

      const clamp = await db.create('clamps', {
        clamp: `${local}:${resolvedLocalId} -> ${remote}:${resolvedRemoteId}`,
        local,
        local_id: resolvedLocalId,
        remote,
        remote_id: resolvedRemoteId,
        context: context || null
      });

      await eventBus.publish('clamp.created', { id: clamp.id, record: clamp });
      return res.status(201).json(clamp);
    } catch (error) {
      return next(error);
    }
  }

  router.post('/links', requireEntityMutationRole, createClampLink);
  router.post('/clamps/link', requireEntityMutationRole, createClampLink);

  router.get('/links', async (req, res, next) => {
    try {
      const { local, local_id, remote, remote_id, context, limit } = req.query;
      let resolvedLocalId = null;
      let resolvedRemoteId = null;

      if (local && local_id && entitySet.has(local)) {
        resolvedLocalId = await db.resolveId(local, local_id);
      }
      if (remote && remote_id && entitySet.has(remote)) {
        resolvedRemoteId = await db.resolveId(remote, remote_id);
      }

      const filters = [];
      if (local) filters.push({ column: 'local', op: 'eq', value: local });
      if (local_id) filters.push({ column: 'local_id', op: 'eq', value: resolvedLocalId || local_id });
      if (remote) filters.push({ column: 'remote', op: 'eq', value: remote });
      if (remote_id) filters.push({ column: 'remote_id', op: 'eq', value: resolvedRemoteId || remote_id });
      if (context) filters.push({ column: 'context', op: 'eq', value: context });

      const filtered = await db.listByFilters('clamps', {
        filters,
        limit: parsePositiveInt(limit, 500, { min: 1, max: 1000 }),
        offset: 0
      });

      return res.json(filtered);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:entity/:id/links', async (req, res, next) => {
    try {
      const { entity, id } = req.params;
      if (!entitySet.has(entity)) {
        return res.status(404).json({ error: `Unknown entity '${entity}'` });
      }

      const normalizedId = validateIdentifier(id, 'id');
      const resolvedId = await db.resolveId(entity, normalizedId);
      const internalId = resolvedId || normalizedId;
      if (!internalId) {
        throw badRequest('Unable to resolve target entity id');
      }

      const links = await db.listByFilters('clamps', {
        filters: [
          { column: 'local', op: 'eq', value: entity },
          { column: 'local_id', op: 'eq', value: internalId }
        ],
        limit: 1000,
        offset: 0
      });
      const reverseLinks = await db.listByFilters('clamps', {
        filters: [
          { column: 'remote', op: 'eq', value: entity },
          { column: 'remote_id', op: 'eq', value: internalId }
        ],
        limit: 1000,
        offset: 0
      });

      return res.json([...links, ...reverseLinks]);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createEntityRouter;

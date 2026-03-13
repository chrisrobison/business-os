const entities = require('../entities');
const { uuid, isUuid } = require('../utils');
const {
  PUBLIC_ID_ENTITIES,
  PUBLIC_ID_START,
  hasPublicId,
  formatPublicId,
  normalizePublicId,
  extractPublicIdSequence
} = require('../publicIds');

const entitySet = new Set(entities);

function parseJsonSafe(value) {
  if (value == null || typeof value === 'object') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function assertEntity(entity) {
  if (!entitySet.has(entity)) {
    throw new Error(`Unknown entity '${entity}'`);
  }
}

function createRepository(connector) {
  const qid = typeof connector.escapeId === 'function' ? connector.escapeId : (name) => name;
  const schemaCache = new Map();

  async function getColumns(entity) {
    assertEntity(entity);
    if (!schemaCache.has(entity)) {
      const columns = typeof connector.describeTable === 'function'
        ? await connector.describeTable(entity)
        : [];
      schemaCache.set(entity, columns);
    }
    return schemaCache.get(entity);
  }

  function toModel(row) {
    const model = {};
    for (const [key, value] of Object.entries(row || {})) {
      model[key] = parseJsonSafe(value);
    }
    return model;
  }

  function normalizeValue(value) {
    if (value == null) return null;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  function writableColumns(columns, { includeId = true } = {}) {
    return columns.filter((col) => {
      if (col.readOnly) return false;
      if (!includeId && col.name === 'id') return false;
      if (col.name === 'public_id') return false;
      if (col.name === 'created' || col.name === 'modified') return false;
      return true;
    });
  }

  function isPublicIdConstraintError(error) {
    if (!error) return false;
    const message = String(error.message || '').toLowerCase();
    return error.code === '23505'
      || error.code === 'ER_DUP_ENTRY'
      || error.code === 'SQLITE_CONSTRAINT'
      || message.includes('duplicate')
      || message.includes('unique constraint failed')
      || message.includes('for key')
      || message.includes('public_id');
  }

  async function ensurePublicIdCounterRow(tx, entity, minimumValue = PUBLIC_ID_START) {
    if (connector.client === 'postgres') {
      await tx.query(
        `INSERT INTO ${qid('public_id_counters')} (${qid('entity')}, ${qid('last_value')}) VALUES (?, ?) ON CONFLICT (${qid('entity')}) DO UPDATE SET ${qid('last_value')} = GREATEST(${qid('public_id_counters')}.${qid('last_value')}, EXCLUDED.${qid('last_value')}), ${qid('updated_at')} = CURRENT_TIMESTAMP`,
        [entity, minimumValue]
      );
      return;
    }

    if (connector.client === 'mysql') {
      await tx.query(
        `INSERT INTO ${qid('public_id_counters')} (${qid('entity')}, ${qid('last_value')}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${qid('last_value')} = GREATEST(${qid('last_value')}, VALUES(${qid('last_value')})), ${qid('updated_at')} = CURRENT_TIMESTAMP`,
        [entity, minimumValue]
      );
      return;
    }

    await tx.query(
      `INSERT INTO ${qid('public_id_counters')} (${qid('entity')}, ${qid('last_value')}) VALUES (?, ?) ON CONFLICT(${qid('entity')}) DO UPDATE SET ${qid('last_value')} = CASE WHEN ${qid('public_id_counters')}.${qid('last_value')} < excluded.${qid('last_value')} THEN excluded.${qid('last_value')} ELSE ${qid('public_id_counters')}.${qid('last_value')} END, ${qid('updated_at')} = CURRENT_TIMESTAMP`,
      [entity, minimumValue]
    );
  }

  async function nextPublicIdSequence(tx, entity) {
    await ensurePublicIdCounterRow(tx, entity, PUBLIC_ID_START);

    if (connector.client === 'postgres') {
      const rows = await tx.query(
        `UPDATE ${qid('public_id_counters')} SET ${qid('last_value')} = ${qid('last_value')} + 1, ${qid('updated_at')} = CURRENT_TIMESTAMP WHERE ${qid('entity')} = ? RETURNING ${qid('last_value')} AS ${qid('next_value')}`,
        [entity]
      );
      return Number(rows[0].next_value);
    }

    if (connector.client === 'mysql') {
      await tx.query(
        `UPDATE ${qid('public_id_counters')} SET ${qid('last_value')} = LAST_INSERT_ID(${qid('last_value')} + 1), ${qid('updated_at')} = CURRENT_TIMESTAMP WHERE ${qid('entity')} = ?`,
        [entity]
      );
      const rows = await tx.query('SELECT LAST_INSERT_ID() AS next_value');
      return Number(rows[0].next_value);
    }

    await tx.query(
      `UPDATE ${qid('public_id_counters')} SET ${qid('last_value')} = ${qid('last_value')} + 1, ${qid('updated_at')} = CURRENT_TIMESTAMP WHERE ${qid('entity')} = ?`,
      [entity]
    );
    const rows = await tx.query(
      `SELECT ${qid('last_value')} AS ${qid('next_value')} FROM ${qid('public_id_counters')} WHERE ${qid('entity')} = ?`,
      [entity]
    );
    return Number(rows[0].next_value);
  }

  async function allocatePublicId(tx, entity) {
    const nextValue = await nextPublicIdSequence(tx, entity);
    return formatPublicId(entity, nextValue);
  }

  async function create(entity, payload) {
    const columns = await getColumns(entity);
    const writable = writableColumns(columns, { includeId: true });
    const valuesByCol = {};

    for (const col of writable) {
      if (Object.prototype.hasOwnProperty.call(payload, col.name)) {
        valuesByCol[col.name] = normalizeValue(payload[col.name]);
      }
    }

    if (columns.some((c) => c.name === 'id') && !valuesByCol.id) {
      valuesByCol.id = payload.id || uuid();
    }

    if (columns.some((c) => c.name === 'public_id')) {
      valuesByCol.public_id = normalizePublicId(payload.public_id) || null;
    }

    const colNames = Object.keys(valuesByCol).filter((name) => valuesByCol[name] !== undefined);
    if (colNames.length === 0) {
      throw new Error(`No writable fields provided for ${entity}`);
    }

    const hasGeneratedPublicId = columns.some((c) => c.name === 'public_id')
      && hasPublicId(entity)
      && !valuesByCol.public_id;

    const sql = `INSERT INTO ${qid(entity)} (${colNames.map(qid).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`;

    if (!hasGeneratedPublicId || typeof connector.transaction !== 'function') {
      await connector.query(sql, colNames.map((name) => valuesByCol[name]));
      if (valuesByCol.id) {
        return getById(entity, valuesByCol.id);
      }
      const rows = await list(entity, { limit: 1, offset: 0 });
      return rows[0] || null;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await connector.transaction(async (tx) => {
          valuesByCol.public_id = await allocatePublicId(tx, entity);
          const insertCols = [...colNames.filter((name) => name !== 'public_id'), 'public_id'];
          const insertSql = `INSERT INTO ${qid(entity)} (${insertCols.map(qid).join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`;
          await tx.query(insertSql, insertCols.map((name) => valuesByCol[name]));
        });
        return getById(entity, valuesByCol.id);
      } catch (error) {
        if (!isPublicIdConstraintError(error) || attempt === 7) {
          throw error;
        }
      }
    }

    throw new Error(`Failed to allocate public ID for ${entity}`);
  }

  async function getById(entity, id) {
    const columns = await getColumns(entity);
    const idColumn = columns.find((c) => c.name === 'id');
    if (!idColumn) {
      return null;
    }

    if (connector.client === 'postgres') {
      const idType = String(idColumn.type || '').toLowerCase();
      if (idType.includes('uuid') && !isUuid(id)) {
        return null;
      }
    }

    const rows = await connector.query(`SELECT * FROM ${qid(entity)} WHERE ${qid('id')} = ? LIMIT 1`, [id]);
    return rows[0] ? toModel(rows[0]) : null;
  }

  async function getByPublicId(entity, publicId) {
    const columns = await getColumns(entity);
    if (!columns.some((c) => c.name === 'public_id')) {
      return null;
    }

    const normalized = normalizePublicId(publicId);
    if (!normalized) return null;

    const rows = await connector.query(`SELECT * FROM ${qid(entity)} WHERE ${qid('public_id')} = ? LIMIT 1`, [normalized]);
    return rows[0] ? toModel(rows[0]) : null;
  }

  async function getByIdentifier(entity, identifier) {
    const value = String(identifier || '').trim();
    if (!value) return null;

    const byId = await getById(entity, value);
    if (byId) return byId;

    return getByPublicId(entity, value);
  }

  async function resolveId(entity, identifier) {
    const row = await getByIdentifier(entity, identifier);
    return row ? row.id : null;
  }

  async function count(entity) {
    await getColumns(entity);
    const rows = await connector.query(`SELECT COUNT(*) AS total FROM ${qid(entity)}`);
    const totalRaw = rows[0] && (rows[0].total ?? rows[0]['COUNT(*)'] ?? rows[0].count);
    return Number(totalRaw || 0);
  }

  async function list(entity, options = {}) {
    const columns = await getColumns(entity);
    const { q, limit = 25, offset = 0 } = options;

    const sortColumn = columns.some((c) => c.name === 'modified')
      ? 'modified'
      : (columns.some((c) => c.name === 'created') ? 'created' : (columns[0] && columns[0].name) || 'id');

    if (!q) {
      const rows = await connector.query(
        `SELECT * FROM ${qid(entity)} ORDER BY ${qid(sortColumn)} DESC LIMIT ? OFFSET ?`,
        [Math.min(limit, 200), offset]
      );
      return rows.map(toModel);
    }

    const searchable = columns
      .filter((c) => {
        const t = String(c.type || '').toLowerCase();
        return ['char', 'text', 'varchar', 'uuid', 'date', 'time'].some((hint) => t.includes(hint)) || c.name === 'id';
      });

    if (searchable.length === 0) {
      const rows = await connector.query(
        `SELECT * FROM ${qid(entity)} ORDER BY ${qid(sortColumn)} DESC LIMIT ? OFFSET ?`,
        [Math.min(limit, 200), offset]
      );
      return rows.map(toModel);
    }

    const exact = await getByIdentifier(entity, q);
    const search = `%${q}%`;
    const where = searchable
      .map((column) => {
        if (connector.client === 'postgres') {
          return `CAST(${qid(column.name)} AS TEXT) LIKE ?`;
        }
        return `${qid(column.name)} LIKE ?`;
      })
      .join(' OR ');
    const params = [...searchable.map(() => search), Math.min(limit, 200), offset];

    const rows = await connector.query(
      `SELECT * FROM ${qid(entity)} WHERE ${where} ORDER BY ${qid(sortColumn)} DESC LIMIT ? OFFSET ?`,
      params
    );

    const mapped = rows.map(toModel);
    if (!exact) {
      return mapped;
    }

    const withoutExact = mapped.filter((row) => row.id !== exact.id);
    return [exact, ...withoutExact];
  }

  async function updateById(entity, id, payload) {
    const columns = await getColumns(entity);
    const current = await getById(entity, id);
    if (!current) return null;

    const writable = writableColumns(columns, { includeId: false });
    const sets = [];
    const params = [];

    for (const col of writable) {
      if (Object.prototype.hasOwnProperty.call(payload, col.name)) {
        sets.push(`${qid(col.name)} = ?`);
        params.push(normalizeValue(payload[col.name]));
      }
    }

    if (columns.some((c) => c.name === 'modified')) {
      sets.push(`${qid('modified')} = CURRENT_TIMESTAMP`);
    }

    if (sets.length === 0) {
      return current;
    }

    await connector.query(
      `UPDATE ${qid(entity)} SET ${sets.join(', ')} WHERE ${qid('id')} = ?`,
      [...params, id]
    );

    return getById(entity, id);
  }

  async function update(entity, identifier, payload) {
    const row = await getByIdentifier(entity, identifier);
    if (!row) return null;
    return updateById(entity, row.id, payload);
  }

  async function remove(entity, identifier) {
    const existing = await getByIdentifier(entity, identifier);
    if (!existing) return false;
    await connector.query(`DELETE FROM ${qid(entity)} WHERE ${qid('id')} = ?`, [existing.id]);
    return true;
  }

  async function describe(entity) {
    return getColumns(entity);
  }

  async function refreshSchema(entity) {
    schemaCache.delete(entity);
    return getColumns(entity);
  }

  async function appendEvent(eventName, payload) {
    const id = uuid();
    await connector.query(
      `INSERT INTO ${qid('system_events')} (${qid('id')}, ${qid('event_name')}, ${qid('payload')}) VALUES (?, ?, ?)`,
      [id, eventName, JSON.stringify(payload || {})]
    );
    return { id, event_name: eventName, payload, created_at: new Date().toISOString() };
  }

  async function listEvents(limit = 100) {
    const rows = await connector.query(
      `SELECT * FROM ${qid('system_events')} ORDER BY ${qid('created_at')} DESC LIMIT ?`,
      [Math.min(limit, 500)]
    );
    return rows.map((row) => ({ ...row, payload: parseJsonSafe(row.payload) }));
  }

  async function backfillPublicIds({ targetEntities = PUBLIC_ID_ENTITIES } = {}) {
    const results = [];

    for (const entity of targetEntities) {
      const columns = await getColumns(entity);
      if (!columns.some((c) => c.name === 'public_id')) {
        results.push({ entity, hasPublicId: false, filled: 0 });
        continue;
      }

      const rows = await connector.query(
        `SELECT ${qid('id')}, ${qid('public_id')}, ${qid('created')} FROM ${qid(entity)} ORDER BY ${qid('created')} ASC, ${qid('id')} ASC`
      );

      let maxSequence = PUBLIC_ID_START;
      for (const row of rows) {
        const parsed = extractPublicIdSequence(entity, row.public_id);
        if (parsed && parsed > maxSequence) {
          maxSequence = parsed;
        }
      }

      if (typeof connector.transaction === 'function') {
        await connector.transaction(async (tx) => {
          await ensurePublicIdCounterRow(tx, entity, maxSequence);
        });
      }

      let filled = 0;
      for (const row of rows) {
        if (normalizePublicId(row.public_id)) {
          continue;
        }

        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            await connector.transaction(async (tx) => {
              const publicId = await allocatePublicId(tx, entity);
              await tx.query(
                `UPDATE ${qid(entity)} SET ${qid('public_id')} = ?, ${qid('modified')} = CURRENT_TIMESTAMP WHERE ${qid('id')} = ? AND (${qid('public_id')} IS NULL OR TRIM(${qid('public_id')}) = '')`,
                [publicId, row.id]
              );
            });
            filled += 1;
            break;
          } catch (error) {
            if (!isPublicIdConstraintError(error) || attempt === 7) {
              throw error;
            }
          }
        }
      }

      results.push({ entity, hasPublicId: true, total: rows.length, filled });
    }

    return results;
  }

  return {
    client: connector.client,
    query: connector.query,
    transaction: connector.transaction,
    initSchema: connector.initSchema,
    applyMigration: connector.applyMigration,
    close: connector.close,
    create,
    getById,
    getByPublicId,
    getByIdentifier,
    resolveId,
    list,
    count,
    update,
    remove,
    describe,
    refreshSchema,
    appendEvent,
    listEvents,
    backfillPublicIds
  };
}

module.exports = createRepository;

const { buildSchema } = require('./entitySchemas');
const entities = require('./entities');
const { isUuid } = require('./utils');

const entitySet = new Set(entities);

function badRequest(message, details = null) {
  const err = new Error(message);
  err.statusCode = 400;
  if (details) {
    err.details = details;
  }
  return err;
}

function parsePositiveInt(value, fallback, { min = 0, max = 500 } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    throw badRequest(`Expected integer but got '${value}'`);
  }
  if (parsed < min || parsed > max) {
    throw badRequest(`Integer '${parsed}' must be between ${min} and ${max}`);
  }
  return parsed;
}

function assertAllowedKeys(payload, allowedKeys, contextLabel = 'payload') {
  const unknown = Object.keys(payload || {}).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw badRequest(`Unknown field(s) in ${contextLabel}: ${unknown.join(', ')}`);
  }
}

function validatePrimitiveType(value, fieldType, fieldName) {
  if (value == null) return;

  if (fieldType === 'boolean' && typeof value !== 'boolean') {
    throw badRequest(`'${fieldName}' must be a boolean`);
  }

  if ((fieldType === 'integer' || fieldType === 'money') && typeof value !== 'number') {
    throw badRequest(`'${fieldName}' must be a number`);
  }

  if (fieldType === 'id' && typeof value !== 'string') {
    throw badRequest(`'${fieldName}' must be a string identifier`);
  }

  if (['string', 'text', 'phone', 'email', 'url', 'date', 'datetime', 'timestamp'].includes(fieldType) && typeof value !== 'string') {
    throw badRequest(`'${fieldName}' must be a string`);
  }
}

function validateEntityPayload(entity, payload, { partial = false } = {}) {
  if (!entitySet.has(entity)) {
    throw badRequest(`Unknown entity '${entity}'`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('Request body must be a JSON object');
  }

  const schema = buildSchema(entity);
  const writableColumns = schema.columns.filter((column) => !column.readOnly && column.name !== 'created' && column.name !== 'modified');
  const allowed = new Set(writableColumns.map((column) => column.name));

  assertAllowedKeys(payload, allowed, `${entity} payload`);

  if (!partial && Object.keys(payload).length === 0) {
    throw badRequest('Request body cannot be empty');
  }

  for (const column of writableColumns) {
    if (!Object.prototype.hasOwnProperty.call(payload, column.name)) continue;
    validatePrimitiveType(payload[column.name], column.type, column.name);
    if (column.type === 'id' && payload[column.name] && !isUuid(String(payload[column.name]))) {
      throw badRequest(`'${column.name}' must be a UUID`);
    }
  }
}

function validateIdentifier(identifier, name = 'identifier') {
  const value = String(identifier || '').trim();
  if (!value) {
    throw badRequest(`'${name}' is required`);
  }
  return value;
}

function wrapValidated(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  badRequest,
  parsePositiveInt,
  validateEntityPayload,
  validateIdentifier,
  assertAllowedKeys,
  wrapValidated
};

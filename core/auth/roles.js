const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  STAFF: 'staff',
  VIEWER: 'viewer'
});

const VALID_ROLES = new Set(Object.values(ROLES));

function normalizeRole(value, fallback = ROLES.VIEWER) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : fallback;
}

function canMutateEntities(role) {
  const normalized = normalizeRole(role);
  return normalized === ROLES.OWNER || normalized === ROLES.ADMIN || normalized === ROLES.STAFF;
}

function canAccessTenancyAdmin(role) {
  const normalized = normalizeRole(role);
  return normalized === ROLES.OWNER || normalized === ROLES.ADMIN;
}

module.exports = {
  ROLES,
  VALID_ROLES,
  normalizeRole,
  canMutateEntities,
  canAccessTenancyAdmin
};

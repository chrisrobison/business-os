const { getRequestContext, runWithRequestContext } = require('../requestContext');
const { verifyJwt } = require('./jwt');
const { createAuthStore } = require('./store');
const { verifyPassword } = require('./passwords');
const { canMutateEntities, normalizeRole } = require('./roles');

function extractBearerToken(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value) return null;

  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function createAuthMiddleware({ db, authConfig }) {
  const authStore = createAuthStore(db);

  function getTenantIdFromContext() {
    const context = getRequestContext();
    return context && context.instance ? context.instance.id : null;
  }

  async function loginHandler(req, res, next) {
    try {
      const email = String((req.body && req.body.email) || '').trim();
      const password = String((req.body && req.body.password) || '');
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
      }

      const tenantId = getTenantIdFromContext();
      const tenantKey = tenantId || 'default';
      const identity = await authStore.findByEmail(email, tenantKey);
      if (!identity || String(identity.status || '').toLowerCase() !== 'active') {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const isValidPassword = verifyPassword(password, identity.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = await db.getByIdentifier('users', identity.user_id);
      if (!user) {
        return res.status(401).json({ error: 'Invalid auth identity' });
      }

      const role = normalizeRole(identity.role, 'viewer');
      const token = authConfig.signToken({
        sub: user.id,
        tid: tenantId,
        role,
        email: identity.email
      });

      return res.json({
        token,
        tokenType: 'Bearer',
        expiresInSeconds: authConfig.tokenTtlSeconds,
        user: {
          id: user.id,
          email: identity.email,
          role,
          tenantId
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  function authenticateRequest(options = {}) {
    const allowAnonymousPaths = new Set(options.allowAnonymousPaths || []);

    return async (req, res, next) => {
      if (allowAnonymousPaths.has(req.path)) {
        return next();
      }

      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      let payload;
      try {
        payload = verifyJwt(token, authConfig.jwtSecret);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      const context = getRequestContext() || {};
      const contextTenantId = context.instance ? context.instance.id : null;
      const tokenTenantId = payload.tid || null;

      if (contextTenantId && tokenTenantId && contextTenantId !== tokenTenantId) {
        return res.status(403).json({ error: 'Token tenant does not match request tenant' });
      }

      const effectiveTenantId = contextTenantId || tokenTenantId || null;
      const tenantKey = effectiveTenantId || 'default';

      try {
        const identity = await authStore.findByUserId(payload.sub, tenantKey);
        if (!identity || String(identity.status || '').toLowerCase() !== 'active') {
          return res.status(401).json({ error: 'Authentication required' });
        }

        const role = normalizeRole(identity.role, 'viewer');
        req.auth = {
          userId: identity.user_id,
          email: identity.email,
          role,
          tenantId: effectiveTenantId
        };
        req.user = req.auth;
        req.userId = req.auth.userId;
        req.tenantId = req.auth.tenantId;

        const nextContext = {
          ...context,
          tenantId: req.auth.tenantId,
          userId: req.auth.userId,
          userRole: req.auth.role,
          auth: req.auth
        };

        return runWithRequestContext(nextContext, () => next());
      } catch (error) {
        return next(error);
      }
    };
  }

  function requireRoles(allowedRoles) {
    const allowed = new Set((allowedRoles || []).map((role) => normalizeRole(role, 'viewer')));

    return (req, res, next) => {
      if (!req.auth) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const userRole = normalizeRole(req.auth.role, 'viewer');
      if (!allowed.has(userRole)) {
        return res.status(403).json({ error: 'Insufficient role for this route' });
      }

      return next();
    };
  }

  function requireEntityMutationRole(req, res, next) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!canMutateEntities(req.auth.role)) {
      return res.status(403).json({ error: 'Insufficient role for entity mutation' });
    }

    return next();
  }

  return {
    loginHandler,
    authenticateRequest,
    requireRoles,
    requireEntityMutationRole
  };
}

module.exports = {
  createAuthMiddleware
};

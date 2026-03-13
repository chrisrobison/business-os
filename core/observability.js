const { uuid } = require('./utils');

function nowMs() {
  return Date.now();
}

function toRouteKey(req) {
  const routePath = req.route && req.route.path ? req.route.path : null;
  return `${req.method} ${routePath ? String(routePath) : req.path || ''}`.trim();
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(index, 0)];
}

function createMetricsRegistry() {
  const counters = new Map();
  const latencies = new Map();

  function increment(routeKey, statusCode, durationMs) {
    const key = `${routeKey}|${statusCode}`;
    counters.set(key, (counters.get(key) || 0) + 1);
    const items = latencies.get(routeKey) || [];
    items.push(durationMs);
    if (items.length > 1000) {
      items.shift();
    }
    latencies.set(routeKey, items);
  }

  function snapshot() {
    const routes = {};
    for (const [key, count] of counters.entries()) {
      const [routeKey, statusCode] = key.split('|');
      routes[routeKey] = routes[routeKey] || {
        count: 0,
        errors: 0,
        statuses: {},
        p95Ms: 0
      };
      routes[routeKey].count += count;
      routes[routeKey].statuses[statusCode] = count;
      if (Number(statusCode) >= 400) {
        routes[routeKey].errors += count;
      }
    }

    for (const [routeKey, values] of latencies.entries()) {
      routes[routeKey] = routes[routeKey] || {
        count: 0,
        errors: 0,
        statuses: {},
        p95Ms: 0
      };
      routes[routeKey].p95Ms = percentile(values, 95);
    }

    return routes;
  }

  return { increment, snapshot };
}

function createRequestTelemetry({ getContext, metrics }) {
  return (req, res, next) => {
    const startedAtMs = nowMs();
    const requestId = String(req.headers['x-request-id'] || '').trim() || uuid();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const durationMs = nowMs() - startedAtMs;
      const context = (typeof getContext === 'function' ? getContext() : null) || {};
      const routeKey = toRouteKey(req);
      metrics.increment(routeKey, res.statusCode, durationMs);

      const payload = {
        level: 'info',
        at: new Date().toISOString(),
        type: 'http_request',
        requestId,
        method: req.method,
        path: req.path,
        route: routeKey,
        status: res.statusCode,
        latencyMs: durationMs,
        tenantId: context.tenantId || (context.instance ? context.instance.id : null) || null,
        userId: context.userId || null
      };
      console.log(JSON.stringify(payload));
    });

    next();
  };
}

module.exports = {
  createMetricsRegistry,
  createRequestTelemetry
};

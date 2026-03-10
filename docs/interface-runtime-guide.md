# Interface Runtime Guide

This guide explains how to implement new user-facing interfaces in Business OS using the app-definition runtime (`/app`) and keep the generic dashboard (`/dashboard`) as a raw admin surface.

## Architecture Overview

Business OS has two UI surfaces:

- Admin console: `/dashboard`
  - Schema-driven CRUD over all tables
  - Intended for low-level, raw access
- User runtime: `/app`
  - App-definition driven navigation + tabs
  - Uses custom web components for interface screens
  - Uses LARC (`@larcjs/core-lite`) for client event orchestration

Core files:

- Runtime shell: `ui/app/index.html`, `ui/app/main.js`, `ui/app/styles.css`
- Base component example: `ui/app/components/bos-entity-form.js`
- App definition loader/validator: `core/appDefinitions.js`
- Runtime APIs and hook execution: `core/server.js`
- App definitions: `config/apps/*.json`

## App Definition Model

App definitions are JSON files in `config/apps/`.

Minimal shape:

```json
{
  "version": "1.0",
  "app": {
    "id": "default",
    "name": "Business Workspace"
  },
  "navigation": []
}
```

Navigation items support:

- `id` (string, required)
- `title` (string, required)
- `componentTag` (string, optional for leaf nodes)
- `componentProps` (object)
- `meta` (object)
- `hooks` (object of event arrays)
- `children` (array for tree/group nodes)

Allowed hook events:

- `onLoad`
- `onView`
- `beforeSave`
- `onSave`
- `afterSave`

Each hook entry:

```json
{
  "type": "client|server",
  "name": "namespace.action",
  "options": {}
}
```

## Runtime Flow

1. Browser loads `/app` and initializes `<pan-bus>`.
2. Runtime fetches `/api/apps/:appId`.
3. Runtime renders left navigation tree from `navigation`.
4. Clicking a nav leaf publishes `runtime.nav.open` on the bus.
5. Runtime opens/activates a tab and mounts the mapped web component.
6. Component emits lifecycle events (`bos:runtime-event`).
7. Runtime maps those events to configured hooks:
   - Client hooks: handled in browser registry (`clientHookRegistry`)
   - Server hooks: POST to `/api/apps/:appId/hooks/:hookName`

## LARC Topic Contracts

Current runtime topics:

- `runtime.nav.open`
  - Payload: `{ appId, navItemId }`
- `runtime.event`
  - Payload: `{ appId, navItemId, eventName, context }`

Recommendation: keep topic contracts stable and versioned to avoid breaking existing components.

## Implementing a New Interface

### 1. Create a web component

Add a component file in `ui/app/components/`, e.g.:

- `ui/app/components/orders-kanban.js`

Register it:

```js
customElements.define('orders-kanban', OrdersKanban);
```

Runtime requirement:

- Component should expose `config` setter/getter.
- Component should emit `bos:runtime-event` for lifecycle hooks.

Event example:

```js
this.dispatchEvent(new CustomEvent('bos:runtime-event', {
  detail: { event: 'onView', context: { id: orderId } },
  bubbles: true,
  composed: true
}));
```

### 2. Import component into runtime bundle

In `ui/app/main.js`, add:

```js
import './components/orders-kanban.js';
```

### 3. Add nav item to app definition

In `config/apps/default.json`:

```json
{
  "id": "orders-kanban",
  "title": "Order Board",
  "componentTag": "orders-kanban",
  "componentProps": {
    "entity": "orders"
  },
  "hooks": {
    "onLoad": [{ "type": "client", "name": "client.notifyLoaded" }],
    "afterSave": [{ "type": "server", "name": "server.auditSave", "options": { "area": "orders" } }]
  }
}
```

### 4. Add hooks if needed

Client hooks:

- Add handlers in `clientHookRegistry` in `ui/app/main.js`.

Server hooks:

- Add allowlisted handlers in `serverHookRegistry` in `core/server.js`.

## API Reference

- `GET /api/apps`
  - Lists app IDs and default app id
- `GET /api/apps/:appId`
  - Returns validated app JSON
- `POST /api/apps/:appId/hooks/:hookName`
  - Executes a server hook from allowlist

## Configuration

Environment variables:

- `APPS_DIR` (default: `config/apps`)
- `DEFAULT_APP_ID` (default: `default`)

## Validation and Troubleshooting

- Invalid app JSON returns validation errors from `core/appDefinitions.js`.
- Unknown component tag shows fallback panel in runtime tab.
- Missing client hook logs warning in browser console.
- Unknown server hook returns `404` from hook endpoint.

## Developer Guidelines

- Keep `/dashboard` behavior generic and low-level.
- Put business workflows into `/app` components and app definitions.
- Prefer explicit hook names and small, composable handlers.
- Avoid arbitrary code execution from JSON definitions; use allowlisted registries.
- Add tests for new hook/event behavior when expanding runtime logic.

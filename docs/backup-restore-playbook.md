# Backup and Restore Playbook

## Scope
This playbook covers backup and restore for:
- control-plane database (`CONTROL_DB_*`)
- tenant databases (`DB_*` per instance)

## Backup Strategy

### Postgres
1. Control DB backup:
```bash
pg_dump -h "$CONTROL_DB_HOST" -p "$CONTROL_DB_PORT" -U "$CONTROL_DB_USER" -d "$CONTROL_DB_NAME" -Fc -f backups/control-$(date +%F-%H%M%S).dump
```
2. Tenant DB backup:
```bash
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Fc -f backups/tenant-$(date +%F-%H%M%S).dump
```

### SQLite
1. Control DB backup:
```bash
cp "$CONTROL_DB_FILE" "backups/control-$(date +%F-%H%M%S).sqlite"
```
2. Tenant DB backup:
```bash
cp "$DB_FILE" "backups/tenant-$(date +%F-%H%M%S).sqlite"
```

## Restore Procedure

### Postgres restore
1. Stop writes to application.
2. Restore control DB:
```bash
pg_restore -h "$CONTROL_DB_HOST" -p "$CONTROL_DB_PORT" -U "$CONTROL_DB_USER" -d "$CONTROL_DB_NAME" --clean --if-exists backups/control-<timestamp>.dump
```
3. Restore tenant DB:
```bash
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --clean --if-exists backups/tenant-<timestamp>.dump
```
4. Start app and run readiness check:
```bash
curl -fsS http://localhost:3010/ready
```

### SQLite restore
1. Stop application.
2. Replace database files with selected backup copies.
3. Start application and verify:
```bash
curl -fsS http://localhost:3010/ready
```

## Verification Checklist
- `/health` returns `ok: true`
- `/ready` returns `ok: true`
- login works for owner account
- tenant host resolution works for at least one mapped domain
- recent records are queryable via `/api/*`

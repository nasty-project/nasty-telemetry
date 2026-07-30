CREATE TABLE IF NOT EXISTS telemetry (
  instance_id TEXT NOT NULL,
  reported_at TEXT NOT NULL DEFAULT (date('now')),
  drives INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  version TEXT,
  commit_sha TEXT,
  vms INTEGER,
  apps INTEGER,
  arch TEXT,
  PRIMARY KEY (instance_id, reported_at)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_reported_at
  ON telemetry (reported_at, instance_id);

-- Migration for existing databases. Run once via:
--   wrangler d1 execute nasty-telemetry --remote --command "ALTER TABLE telemetry ADD COLUMN version TEXT;"
--   wrangler d1 execute nasty-telemetry --remote --command "ALTER TABLE telemetry ADD COLUMN commit_sha TEXT;"
--   wrangler d1 execute nasty-telemetry --remote --command "ALTER TABLE telemetry ADD COLUMN vms INTEGER;"
--   wrangler d1 execute nasty-telemetry --remote --command "ALTER TABLE telemetry ADD COLUMN apps INTEGER;"
--   wrangler d1 execute nasty-telemetry --remote --command "ALTER TABLE telemetry ADD COLUMN arch TEXT;"

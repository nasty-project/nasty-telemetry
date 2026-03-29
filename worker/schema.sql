CREATE TABLE IF NOT EXISTS telemetry (
  instance_id TEXT NOT NULL,
  reported_at TEXT NOT NULL DEFAULT (date('now')),
  drives INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  PRIMARY KEY (instance_id, reported_at)
);

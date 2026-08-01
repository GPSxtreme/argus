export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  raw_json TEXT NOT NULL,
  metadata_json TEXT,
  watch_ids_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE(source, target_id, external_id)
);
CREATE INDEX IF NOT EXISTS records_ingested_idx ON records(ingested_at DESC, id);
CREATE INDEX IF NOT EXISTS records_source_idx ON records(source, target_id);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(record_id, content_hash)
);
CREATE INDEX IF NOT EXISTS revisions_record_idx ON revisions(record_id, created_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  target_id TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  run_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, run_at, lease_expires_at);
CREATE TABLE IF NOT EXISTS diagnostic_watches (
 id TEXT PRIMARY KEY, target_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, target_json TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diagnostic_watches_expiry_idx ON diagnostic_watches(expires_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  record_ids_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applied_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

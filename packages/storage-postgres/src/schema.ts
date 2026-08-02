export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id text PRIMARY KEY,
  source text NOT NULL,
  target_id text NOT NULL,
  external_id text NOT NULL,
  url text NOT NULL,
  title text,
  text text NOT NULL,
  author text,
  published_at timestamptz,
  raw_json jsonb NOT NULL,
  metadata_json jsonb,
  watch_ids_json jsonb NOT NULL,
  content_hash text NOT NULL,
  ingested_at timestamptz NOT NULL,
  search_document tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', coalesce(title, '') || ' ' || text)) STORED,
  UNIQUE(source, target_id, external_id)
);
CREATE INDEX IF NOT EXISTS records_ingested_idx ON records(ingested_at DESC, id);
CREATE INDEX IF NOT EXISTS records_search_idx ON records USING gin(search_document);

CREATE TABLE IF NOT EXISTS revisions (
  id text PRIMARY KEY,
  record_id text NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  title text,
  text text NOT NULL,
  raw_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(record_id, content_hash)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  target_id text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  target_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL,
  run_at timestamptz NOT NULL,
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  error text
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token text;
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, run_at, lease_expires_at);
CREATE TABLE IF NOT EXISTS diagnostic_watches (
 id text PRIMARY KEY, target_id text NOT NULL UNIQUE, source text NOT NULL, target_json jsonb NOT NULL,
 status text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
ALTER TABLE diagnostic_watches
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE diagnostic_watches
  SET expires_at = created_at + interval '15 minutes'
  WHERE expires_at IS NULL;
ALTER TABLE diagnostic_watches
  ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS diagnostic_watches_expiry_idx ON diagnostic_watches(expires_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  record_ids_json jsonb NOT NULL,
  kind text NOT NULL,
  content text NOT NULL,
  provider text,
  model text,
  provenance_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS applied_config (
  id integer PRIMARY KEY CHECK (id = 1),
  config_json jsonb NOT NULL,
  content_hash text NOT NULL,
  applied_at timestamptz NOT NULL
);
`;

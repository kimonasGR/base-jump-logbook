CREATE TABLE IF NOT EXISTS flysight_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flysight_handoffs_user_expiry_idx ON flysight_handoffs(user_id,expires_at);
CREATE TABLE IF NOT EXISTS flysight_handoff_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id UUID NOT NULL REFERENCES flysight_handoffs(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 15728640),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  total_chunks INTEGER NOT NULL CHECK(total_chunks BETWEEN 1 AND 60),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(handoff_id,file_name)
);
CREATE TABLE IF NOT EXISTS flysight_handoff_chunks (
  file_id UUID NOT NULL REFERENCES flysight_handoff_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(file_id,chunk_index),
  CHECK(octet_length(data)<=262144)
);

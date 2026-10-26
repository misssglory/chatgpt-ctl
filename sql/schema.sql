-- ChatGPT history schema
-- Applied by: bun run migrate   or   nix run .#setup-db

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS chats (
  id              UUID PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  url             TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY,
  chat_id         UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT NOT NULL DEFAULT '',
  sequence        INTEGER NOT NULL DEFAULT 0,
  -- true once the watcher observed the message as finished (streaming stopped)
  completed       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS messages_chat_seq_idx
  ON messages (chat_id, sequence);

CREATE INDEX IF NOT EXISTS messages_chat_completed_idx
  ON messages (chat_id, completed, completed_at DESC);

CREATE INDEX IF NOT EXISTS chats_updated_idx
  ON chats (updated_at DESC);

-- Optional fuzzy title index (requires CREATE EXTENSION pg_trgm). Applied best-effort by migrate / setup-db.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS chats_title_trgm_idx ON chats USING gin (title gin_trgm_ops)';
  END IF;
END $$;

COMMENT ON TABLE chats IS 'ChatGPT conversations scraped from the web UI';
COMMENT ON TABLE messages IS 'Individual turns; rows are upserted and marked completed when streaming finishes';

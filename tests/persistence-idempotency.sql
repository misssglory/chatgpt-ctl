-- Regression test for src/index.ts::upsertMessage persistence semantics.
-- Safe to run against any PostgreSQL database: it creates only temporary
-- objects and rolls the transaction back.
BEGIN;

CREATE TEMP TABLE messages (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  sequence integer NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now()
) ON COMMIT DROP;

DO $$
DECLARE
  was_inserted boolean;
  just_completed boolean;
  affected integer;
BEGIN
  -- Initial incomplete observation inserts exactly once.
  INSERT INTO messages (id, chat_id, role, content, sequence, completed, completed_at, created_at)
  VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'assistant', 'partial', 0, false, NULL, NOW())
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    sequence = EXCLUDED.sequence,
    completed = messages.completed OR EXCLUDED.completed,
    completed_at = CASE
      WHEN messages.completed = false AND EXCLUDED.completed = true THEN statement_timestamp()
      ELSE messages.completed_at
    END
  WHERE messages.content IS DISTINCT FROM EXCLUDED.content
     OR messages.sequence IS DISTINCT FROM EXCLUDED.sequence
     OR (messages.completed = false AND EXCLUDED.completed = true)
  RETURNING (xmax = 0), (completed AND completed_at = statement_timestamp())
  INTO was_inserted, just_completed;

  IF NOT FOUND OR was_inserted IS DISTINCT FROM true OR just_completed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'initial incomplete insert did not produce expected status';
  END IF;

  -- Identical poll must not update or return a row.
  INSERT INTO messages (id, chat_id, role, content, sequence, completed, completed_at, created_at)
  VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'assistant', 'partial', 0, false, NULL, NOW())
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    sequence = EXCLUDED.sequence,
    completed = messages.completed OR EXCLUDED.completed,
    completed_at = CASE
      WHEN messages.completed = false AND EXCLUDED.completed = true THEN statement_timestamp()
      ELSE messages.completed_at
    END
  WHERE messages.content IS DISTINCT FROM EXCLUDED.content
     OR messages.sequence IS DISTINCT FROM EXCLUDED.sequence
     OR (messages.completed = false AND EXCLUDED.completed = true);
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'identical incomplete poll performed an update'; END IF;

  -- The one false -> true transition must be reported exactly once.
  INSERT INTO messages (id, chat_id, role, content, sequence, completed, completed_at, created_at)
  VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'assistant', 'final reply', 0, true, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    sequence = EXCLUDED.sequence,
    completed = messages.completed OR EXCLUDED.completed,
    completed_at = CASE
      WHEN messages.completed = false AND EXCLUDED.completed = true THEN statement_timestamp()
      ELSE messages.completed_at
    END
  WHERE messages.content IS DISTINCT FROM EXCLUDED.content
     OR messages.sequence IS DISTINCT FROM EXCLUDED.sequence
     OR (messages.completed = false AND EXCLUDED.completed = true)
  RETURNING (xmax = 0), (completed AND completed_at = statement_timestamp())
  INTO was_inserted, just_completed;

  IF NOT FOUND OR was_inserted IS DISTINCT FROM false OR just_completed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'completion transition was not detected';
  END IF;

  -- The next identical completed poll must be a no-op, not another event.
  INSERT INTO messages (id, chat_id, role, content, sequence, completed, completed_at, created_at)
  VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'assistant', 'final reply', 0, true, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    sequence = EXCLUDED.sequence,
    completed = messages.completed OR EXCLUDED.completed,
    completed_at = CASE
      WHEN messages.completed = false AND EXCLUDED.completed = true THEN statement_timestamp()
      ELSE messages.completed_at
    END
  WHERE messages.content IS DISTINCT FROM EXCLUDED.content
     OR messages.sequence IS DISTINCT FROM EXCLUDED.sequence
     OR (messages.completed = false AND EXCLUDED.completed = true);
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'identical completed poll performed an update'; END IF;

  RAISE NOTICE 'PASS: duplicate polls are no-ops; completion is reported once';
END $$;

ROLLBACK;

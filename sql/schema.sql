-- Core schema for chatgpt-history-watcher.
-- Browser identity is stored in additive watcher-owned tables created by the
-- watcher/ctl at runtime, keeping this base schema compatible with older DBs.

CREATE TABLE IF NOT EXISTS chats (
    id uuid PRIMARY KEY,
    title text NOT NULL DEFAULT '',
    url text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz
);

CREATE TABLE IF NOT EXISTS messages (
    id uuid PRIMARY KEY,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    sequence integer NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chats_updated_at_idx
    ON chats (updated_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS chats_title_idx
    ON chats (title);
CREATE INDEX IF NOT EXISTS messages_chat_sequence_idx
    ON messages (chat_id, sequence);
CREATE INDEX IF NOT EXISTS messages_completed_idx
    ON messages (chat_id, completed, sequence);

CREATE TABLE IF NOT EXISTS chatgpt_watcher_chat_browsers (
    chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    browser_name text NOT NULL DEFAULT 'default',
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatgpt_watcher_browsers (
    name text PRIMARY KEY,
    profile_dir text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);


-- Continuously persisted watcher pane snapshot; used to reopen conversation panes.
ALTER TABLE chatgpt_watcher_browsers ADD COLUMN IF NOT EXISTS auto_open boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS chatgpt_watcher_open_chats (
    browser_name text NOT NULL,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    pane_order integer NOT NULL DEFAULT 0,
    focused_at bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (browser_name, chat_id)
);

CREATE INDEX IF NOT EXISTS chatgpt_watcher_open_chats_focus_idx
    ON chatgpt_watcher_open_chats (focused_at DESC);


-- File picker index, populated from assistant download links and user file
-- controls when a conversation is observed by the watcher.
CREATE TABLE IF NOT EXISTS chatgpt_watcher_files (
    id bigserial PRIMARY KEY,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    identity text NOT NULL,
    role text NOT NULL,
    label text NOT NULL,
    message_id text,
    message_order integer,
    position integer NOT NULL DEFAULT 0,
    user_excerpt text NOT NULL DEFAULT '',
    discovered_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chat_id, identity)
);
CREATE INDEX IF NOT EXISTS chatgpt_watcher_files_fresh_idx
    ON chatgpt_watcher_files (discovered_at DESC, id DESC);

-- Per-profile project preference; new ctl chats inherit this project.
ALTER TABLE chatgpt_watcher_browsers ADD COLUMN IF NOT EXISTS default_project text;

-- Ordered project inventory and resumable scan state, newest project row = 0.
CREATE TABLE IF NOT EXISTS chatgpt_watcher_project_scans (
    browser_name text NOT NULL,
    project_id text NOT NULL,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    project_order integer NOT NULL,
    scanned_at timestamptz,
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (browser_name, project_id, chat_id)
);
CREATE INDEX IF NOT EXISTS watcher_project_scans_pending
    ON chatgpt_watcher_project_scans (browser_name, project_id, project_order)
    WHERE scanned_at IS NULL;

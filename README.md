# chatgpt-history-watcher

Scrape ChatGPT (chatgpt.com) conversation history into **PostgreSQL**, modeled on the same browser-profile / login pattern as `fomo-trending-watcher`.

## Features

- **Login mode without Playwright** — Google / OpenAI often reject automated browsers. `bun run login` starts a *normal* Chromium with `--user-data-dir=./var/chatgpt-profile`. After you sign in and close the window, the profile (cookies, local storage) is reused by Playwright via `launchPersistentContext`.
- **Persist every message when it is completed** — the watcher polls the open chat, detects the “Stop generating” control, and only marks an assistant turn `completed=true` (and stamps `completed_at`) after streaming finishes (with a small settle debounce).
- **PostgreSQL** — `chats` + `messages` tables; upserts are idempotent by ChatGPT UUIDs.
- **`flake.nix`** — `nix run .#setup-db` / `nix run .#flush-db` plus a dev shell with Bun, Chromium, Postgres client tools, and Rust.
- **Rust `chatgpt-ctl`** — list chats, show history of the current (most recent) chat or a specific chat, follow mode, and **DB-backed autocomplete** of chat titles / UUIDs in the interactive prompt. Static shell completions via `chatgpt-ctl completions zsh`.

## Quick start

```bash
# 1. Dev shell (optional but recommended on NixOS)
nix develop

# 2. Database
nix run .#setup-db
# or: bun run migrate   (applies sql/schema.sql using config.toml)

# 3. Edit config.toml — set [browser].executable_path if needed

# 4. One-time login (manual Chromium, no automation)
bun run login
# Sign into ChatGPT, open a chat, close the window.

# 5. Watch the currently open chat; write completed messages to Postgres
bun run watch

# 6. Query with the Rust ctl
cd ctl && cargo build --release
../ctl/target/release/chatgpt-ctl chats
../ctl/target/release/chatgpt-ctl history current
../ctl/target/release/chatgpt-ctl history          # interactive + TAB autocomplete from DB
../ctl/target/release/chatgpt-ctl history --follow current
```

## Commands (Bun / TypeScript)

| Command | Purpose |
|--------|---------|
| `bun run doctor` | Check Chromium + Postgres connectivity |
| `bun run login` | Launch normal Chromium → save profile cookies |
| `bun run migrate` | Apply `sql/schema.sql` |
| `bun run dump` | One-shot scrape of the open chat → DB |
| `bun run once` | Same as dump (alias for “single poll”) |
| `bun run watch` | Continuous poll; persist messages as they complete |

## Commands (Rust ctl)

```text
chatgpt-ctl chats [--limit N] [-q substring]
chatgpt-ctl history [CHAT|current] [--all] [--follow] [--json]
chatgpt-ctl history                 # interactive readline, TAB completes from DB
chatgpt-ctl message <uuid>
chatgpt-ctl completions bash|zsh|fish|elvish|powershell
```

`CHAT` may be a full UUID, a title substring, or the keyword `current` (most recently updated row in `chats`).

### Shell completions

```bash
# zsh example
chatgpt-ctl completions zsh > ~/.zfunc/_chatgpt-ctl
```

Interactive history completion loads titles and ids from Postgres at prompt time (not static).

## flake.nix apps

```bash
nix run .#setup-db    # CREATE ROLE/DATABASE + apply schema.sql
nix run .#flush-db    # TRUNCATE messages, chats
nix develop           # bun, rustc, chromium, psql, …
```

Default connection (override with `DATABASE_URL` or `[database]` in `config.toml`):

```text
postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history
```

## Schema (summary)

```sql
chats(id uuid PK, title, url, updated_at, last_message_at, …)
messages(id uuid PK, chat_id FK, role, content, sequence, completed, completed_at, …)
```

A message row is inserted as soon as it appears in the DOM. `completed` flips to `true` and `completed_at` is set only after the streaming indicator disappears and the settle window elapses.

## DOM notes (from the sample ChatGPT / Codex outerHTML)

- Conversation id: `data-chatgpt-selection-conversation-id` or URL `/c/{uuid}`
- Message ids: `data-chatgpt-search-message-ids`
- User bubbles: `[data-user-message-bubble="true"]`, unit key ending in `:user`
- Assistant: `data-conversation-role="assistant"` / unit key `:assistant`
- Streaming: presence of a “Stop generating” (or aria-label Stop) button

UI changes on chatgpt.com may require selector updates in `src/index.ts` → `scrapeCurrentChat`.

## Config (`config.toml`)

```toml
[chatgpt]
url = "https://chatgpt.com/"
profile_dir = "./var/chatgpt-profile"
poll_ms = 1500
complete_settle_ms = 800
conversation_id = ""          # empty = follow whatever chat is open

[browser]
executable_path = ""          # empty = which chromium / chrome
prefer_system_chromium = true
headless = false
native_window_viewport = true

[database]
url = "postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history"
```

## Relation to fomo-trending-watcher

| Concern | fomo | this project |
|--------|------|--------------|
| Login | Normal Chromium + `--user-data-dir` | Same |
| Runtime browser | `chromium.launchPersistentContext(profile)` | Same |
| Persistence | JSON state file | PostgreSQL |
| External ctl | `ethctl.sh` (bash/TCP) | `chatgpt-ctl` (Rust, SQL + completions) |
| “When to record” | first-seen / rank thresholds | message `completed` (streaming ended) |

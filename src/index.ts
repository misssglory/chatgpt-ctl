/**
 * chatgpt-history-watcher
 *
 * Playwright scraper for ChatGPT conversation history, modeled after
 * fomo-trending-watcher:
 *   - login: launch a NORMAL Chromium process with --user-data-dir so Google /
 *            OpenAI auth cookies land in a reusable profile
 *   - watch / once / dump: launchPersistentContext on that same profile
 *   - every completed message is upserted into PostgreSQL
 */

import { TOML } from "bun";
import { chromium, type BrowserContext, type Download, type Page } from "playwright-core";
import { Logger } from "tslog";
import { access, constants, lstat, mkdir, mkdtemp, readdir, rename, rm, readFile, writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { zipTargetAssociation } from "./zip-target-selection.mjs";

const log = new Logger({
  type: "pretty",
  name: "chatgpt",
  minLevel: "DEBUG",
  pretty: {
    template: "{{dateIsoStr}}\t{{logLevelName}}\t",
    timeZone: "local",
    style: true,
  },
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  chatgpt: {
    url: string;
    profile_dir: string;
    poll_ms?: number;
    complete_settle_ms?: number;
    conversation_id?: string;
  };
  browser?: {
    executable_path?: string;
    prefer_system_chromium?: boolean;
    headless?: boolean;
    /** Enable Chromium's own process sandbox (prevents Playwright adding --no-sandbox). */
    chromium_sandbox?: boolean;
    native_window_viewport?: boolean;
    viewport_width?: number;
    viewport_height?: number;
    navigation_timeout_ms?: number;
    selector_timeout_ms?: number;
  };
  database: {
    url?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    name?: string;
  };
  debug?: { network?: boolean };
  downloads?: { directory?: string };
}

interface ScrapedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  sequence: number;
  /** Stable ChatGPT turn number when exposed by the DOM; absent means order is unknown. */
  turnOrder?: number;
  /** true when the UI no longer shows a streaming / "stop generating" state */
  completed: boolean;
}

interface ScrapedChat {
  id: string;
  title: string;
  url: string;
  messages: ScrapedMessage[];
  isStreaming: boolean;
}

interface SidebarChat {
  id: string;
  title: string;
  url: string;
}

interface BrowserProfile {
  name: string;
  profileDir: string;
}

interface BrowserRuntime extends BrowserProfile {
  context: BrowserContext;
  activePage?: Page;
  lastFocusAt: number;
}

interface VirtualFocus {
  runtime?: BrowserRuntime;
  page?: Page;
  at: number;
  source: "manual" | "ctl";
  /** Per-page timestamps are needed when the previously focused page closes. */
  pageFocusAt: WeakMap<Page, number>;
  /** Persist changes to the open-pane snapshot (debounced by the session store). */
  onChange?: (reason: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge a staged directory into an existing destination. Directories merge
 * recursively; archive files replace conflicting destination files/directories.
 */
async function mergeDirectoryContents(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const children = await readdir(sourceDir, { withFileTypes: true });
  for (const child of children) {
    const source = path.join(sourceDir, child.name);
    const destination = path.join(destinationDir, child.name);
    let destinationIsDirectory = false;
    try {
      destinationIsDirectory = (await lstat(destination)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (child.isDirectory() && destinationIsDirectory) {
      await mergeDirectoryContents(source, destination);
      await rm(source, { recursive: true, force: true });
      continue;
    }

    // Remove any conflicting file, symlink, or directory before moving the
    // staged entry. This avoids rename(2)'s ENOTEMPTY behavior for dir/dir.
    await rm(destination, { recursive: true, force: true });
    await rename(source, destination);
  }
}

function resolveFromConfig(configPath: string, rel: string): string {
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(path.dirname(configPath), rel);
}

function normalizeBrowserName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) {
    throw new Error(`invalid browser name "${raw}"; use 1-48 letters, numbers, '_' or '-'`);
  }
  return name;
}

function browserProfilesRoot(defaultProfileDir: string): string {
  return `${defaultProfileDir}.profiles`;
}

function resolveBrowserProfileDir(cfg: Config, configPath: string, browserName: string): string {
  const name = normalizeBrowserName(browserName);
  const defaultDir = resolveFromConfig(configPath, cfg.chatgpt.profile_dir);
  if (name === "default") return defaultDir;
  return path.join(browserProfilesRoot(defaultDir), name);
}

async function discoverBrowserProfiles(cfg: Config, configPath: string): Promise<BrowserProfile[]> {
  const defaultProfile = resolveBrowserProfileDir(cfg, configPath, "default");
  const profiles: BrowserProfile[] = [{ name: "default", profileDir: defaultProfile }];
  const namedProfiles: BrowserProfile[] = [];
  const root = browserProfilesRoot(defaultProfile);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "default") continue;
      try {
        const name = normalizeBrowserName(entry.name);
        namedProfiles.push({ name, profileDir: path.join(root, name) });
      } catch { /* Ignore folders that are not valid named profiles. */ }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  namedProfiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles.concat(namedProfiles);
}

async function loadConfig(configPath: string): Promise<Config> {
  const raw = await readFile(configPath, "utf8");
  const cfg = TOML.parse(raw) as Config;
  if (!cfg.chatgpt?.url || !cfg.chatgpt?.profile_dir) {
    throw new Error("config.toml: [chatgpt] url and profile_dir are required");
  }
  if (
    !process.env.CHATGPT_DATABASE_URL?.trim() &&
    !cfg.database?.url &&
    !(cfg.database?.host && cfg.database?.name)
  ) {
    throw new Error(
      "Set CHATGPT_DATABASE_URL or config.toml [database] url / host+name"
    );
  }
  return cfg;
}

function databaseUrl(cfg: Config): string {
  // Prefer CHATGPT_DATABASE_URL so the same env works for ctl + watcher.
  const fromEnv = process.env.CHATGPT_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (cfg.database.url && cfg.database.url.trim()) return cfg.database.url.trim();
  const { host, port, user, password, name } = cfg.database;
  return `postgres://${user}:${password}@${host}:${port ?? 5432}/${name}`;
}

async function isNixOS(): Promise<boolean> {
  try {
    await access("/etc/NIXOS", constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandOutput(
  cmd: string[],
  cwd?: string,
  stdinText?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: stdinText === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain output concurrently with writes to avoid pipe-buffer deadlocks when
  // check-ignore returns a large list while also consuming many input paths.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  if (stdinText !== undefined) {
    if (!proc.stdin) throw new Error(`stdin pipe unavailable for command: ${cmd[0]}`);
    await proc.stdin.write(stdinText);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const code = await proc.exited;
  // Preserve NUL-delimited output exactly for --stdin protocols such as
  // `git check-ignore -z`; trimming can corrupt filenames that begin with space.
  return { code, stdout: stdinText === undefined ? stdout.trim() : stdout, stderr: stderr.trim() };
}

async function resolveBrowserExecutable(cfg: Config, _configPath: string): Promise<string> {
  if (cfg.browser?.executable_path) {
    if (!existsSync(cfg.browser.executable_path)) {
      throw new Error(`Configured browser executable not found: ${cfg.browser.executable_path}`);
    }
    return cfg.browser.executable_path;
  }

  const candidates = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
  ];

  for (const name of candidates) {
    const which = await commandOutput(["which", name]);
    if (which.code === 0 && which.stdout) return which.stdout;
  }

  // Playwright channel fallback (last resort — may be blocked by Google login)
  return "chromium";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

function openDb(cfg: Config): Sql {
  const url = databaseUrl(cfg);
  log.info(`[db] connecting ${url.replace(/:[^:@]+@/, ":***@")}`);
  return postgres(url, { max: 4, idle_timeout: 20 });
}

type ChatHook = {
  folder: string;
  child_folder: string;
  nix_flake: boolean;
  clipboard_command: string[];
  build_command: string | null;
  enabled: boolean;
};

async function ensureBrowserSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chatgpt_watcher_chat_browsers (
      chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      browser_name text NOT NULL DEFAULT 'default',
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chatgpt_watcher_browsers (
      name text PRIMARY KEY,
      profile_dir text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Continuously persisted watcher pane snapshot, restored on the next launch.
  // One row represents one open conversation pane; focused_at preserves the
  // virtual-focus choice across browser contexts.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chatgpt_watcher_open_chats (
      browser_name text NOT NULL,
      chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      pane_order integer NOT NULL DEFAULT 0,
      focused_at bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (browser_name, chat_id)
    )
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS chatgpt_watcher_open_chats_focus_idx
    ON chatgpt_watcher_open_chats (focused_at DESC)
  `);
}

async function registerBrowser(sql: Sql, profile: BrowserProfile): Promise<void> {
  await sql`
    INSERT INTO chatgpt_watcher_browsers (name, profile_dir, updated_at)
    VALUES (${profile.name}, ${profile.profileDir}, NOW())
    ON CONFLICT (name) DO UPDATE SET profile_dir=EXCLUDED.profile_dir, updated_at=NOW()
  `;
}

async function recordChatBrowser(sql: Sql, chatId: string, browserName: string): Promise<void> {
  const id = normalizeUuid(chatId);
  if (!id) return;
  await sql`
    INSERT INTO chatgpt_watcher_chat_browsers (chat_id, browser_name, updated_at)
    VALUES (${id}::uuid, ${browserName}, NOW())
    ON CONFLICT (chat_id) DO UPDATE SET browser_name=EXCLUDED.browser_name, updated_at=NOW()
  `;
}

async function browserNameForChat(sql: Sql, chatId: string): Promise<string | null> {
  const rows = await sql`
    SELECT browser_name FROM chatgpt_watcher_chat_browsers WHERE chat_id = ${chatId}::uuid
  `;
  return rows.length ? String(rows[0]!.browser_name) : null;
}

interface SavedOpenChat {
  browser_name: string;
  chat_id: string;
  pane_order: number;
  focused_at: number;
}

async function loadOpenChatSession(sql: Sql): Promise<SavedOpenChat[]> {
  const rows = await sql`
    SELECT browser_name, chat_id::text AS chat_id, pane_order, focused_at::bigint AS focused_at
    FROM chatgpt_watcher_open_chats
    ORDER BY browser_name, pane_order
  `;
  return rows.map((row: any) => ({
    browser_name: String(row.browser_name),
    chat_id: String(row.chat_id),
    pane_order: Number(row.pane_order),
    focused_at: Number(row.focused_at),
  }));
}

async function persistOpenChatSession(
  sql: Sql,
  runtimes: BrowserRuntime[],
  focus: VirtualFocus,
): Promise<number> {
  const snapshot: SavedOpenChat[] = [];
  for (const runtime of runtimes) {
    let paneOrder = 0;
    for (const page of runtime.context.pages()) {
      if (page.isClosed()) continue;
      const chatId = normalizeUuid(page.url());
      if (!chatId) continue; // Ignore blank tabs, ChatGPT home, and transient new chats.
      let focusedAt = focus.pageFocusAt.get(page) ?? 0;
      if (focus.page === page) focusedAt = Math.max(focusedAt, focus.at);
      snapshot.push({
        browser_name: runtime.name,
        chat_id: chatId,
        pane_order: paneOrder++,
        focused_at: focusedAt,
      });
    }
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM chatgpt_watcher_open_chats`;
    for (const item of snapshot) {
      // A pane can be opened immediately before Ctrl+C, before the polling
      // loop has persisted its chat row. Create a placeholder so the session
      // foreign key cannot make shutdown lose the entire snapshot.
      await tx`
        INSERT INTO chats (id, title, url, created_at, updated_at)
        VALUES (${item.chat_id}::uuid, '', ${`/c/${item.chat_id}`}, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO chatgpt_watcher_chat_browsers (chat_id, browser_name, updated_at)
        VALUES (${item.chat_id}::uuid, ${item.browser_name}, NOW())
        ON CONFLICT (chat_id) DO UPDATE
          SET browser_name = EXCLUDED.browser_name, updated_at = NOW()
      `;
      await tx`
        INSERT INTO chatgpt_watcher_open_chats
          (browser_name, chat_id, pane_order, focused_at, updated_at)
        VALUES
          (${item.browser_name}, ${item.chat_id}::uuid, ${item.pane_order}, ${item.focused_at}, NOW())
      `;
    }
  });
  return snapshot.length;
}

/**
 * Persist pane/focus changes continuously instead of relying on SIGINT. The
 * snapshot writer is serialized, debounced, and paused while startup restores
 * the saved rows so intermediate restoration states cannot erase panes that
 * have not been reopened yet.
 */
function createOpenChatSessionPersistence(
  sql: Sql,
  runtimes: BrowserRuntime[],
  focus: VirtualFocus,
) {
  let paused = true;
  let dirty = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<number> | undefined;
  let lastSavedCount = 0;
  let lastError: unknown;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const drain = async (): Promise<void> => {
    if (paused || !dirty) return;
    if (inFlight) {
      await inFlight.catch(() => undefined);
      if (dirty && !paused) await drain();
      return;
    }

    dirty = false;
    const startedAtRevision = revision;
    inFlight = persistOpenChatSession(sql, runtimes, focus);
    try {
      lastSavedCount = await inFlight;
      lastError = undefined;
      log.debug(`[watch] persisted ${lastSavedCount} open chat(s) (revision=${startedAtRevision})`);
    } catch (error) {
      lastError = error;
      // Retry only when a newer change arrived during the failed write. A
      // persistent DB failure must not create an endless log/retry loop.
      if (revision > startedAtRevision) dirty = true;
      log.error(`[watch] failed to persist open-chat changes: ${formatError(error)}`);
      throw error;
    } finally {
      inFlight = undefined;
    }

    if (dirty && !paused) await drain();
  };

  const arm = () => {
    if (paused || !dirty) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void drain().catch(() => undefined);
    }, 200);
  };

  return {
    schedule(_reason: string) {
      revision++;
      dirty = true;
      arm();
    },
    resume() {
      if (!paused) return;
      paused = false;
      arm();
    },
    async flush(): Promise<number> {
      clearTimer();
      paused = false;
      if (!dirty) {
        // A caller may request a final checkpoint even if no event was seen.
        revision++;
        dirty = true;
      }
      await drain();
      if (inFlight) await inFlight.catch(() => undefined);
      if (lastError) throw lastError;
      return lastSavedCount;
    },
  };
}

async function restoreOpenChatSession(
  sql: Sql,
  runtimes: BrowserRuntime[],
  focus: VirtualFocus,
  cfg: Config,
): Promise<number> {
  const saved = await loadOpenChatSession(sql);
  if (saved.length === 0) return 0;

  let restoredCount = 0;
  const focusCandidates: Array<{ runtime: BrowserRuntime; page: Page; focusedAt: number }> = [];
  for (const runtime of runtimes) {
    const rows = saved
      .filter((item) => item.browser_name === runtime.name)
      .sort((a, b) => a.pane_order - b.pane_order);
    if (rows.length === 0) continue;

    const existing = new Map<string, Page>();
    for (const page of runtime.context.pages()) {
      const id = page.isClosed() ? null : normalizeUuid(page.url());
      if (id) existing.set(id, page);
    }
    // Reuse the launcher's blank/home page for the first restored conversation;
    // create additional tabs only when all existing pages already hold chats.
    let reusablePage = runtime.context.pages().find((page) =>
      !page.isClosed() && !normalizeUuid(page.url())
    );

    for (const item of rows) {
      let page = existing.get(item.chat_id);
      if (!page) {
        const reusedLauncherPage = Boolean(reusablePage);
        page = reusablePage ?? await runtime.context.newPage();
        reusablePage = undefined;
        configurePage(page, cfg);
        attachNetworkDebug(page, cfg);
        const target = new URL(`/c/${item.chat_id}`, cfg.chatgpt.url).toString();
        try {
          await page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: cfg.browser?.navigation_timeout_ms ?? 45_000,
          });
          if (normalizeUuid(page.url()) !== item.chat_id) {
            log.warn(`[watch] skipped stale saved chat=${item.chat_id} browser=${runtime.name}; redirected to ${page.url()}`);
            if (!reusedLauncherPage) await page.close().catch(() => undefined);
            continue;
          }
          existing.set(item.chat_id, page);
          restoredCount++;
          log.info(`[watch] restored chat=${item.chat_id} browser=${runtime.name} pane=${item.pane_order}`);
        } catch (error) {
          log.warn(`[watch] could not restore chat=${item.chat_id} browser=${runtime.name}: ${formatError(error)}`);
          if (!reusedLauncherPage) await page.close().catch(() => undefined);
          continue;
        }
      } else {
        restoredCount++;
        log.info(`[watch] retained existing chat=${item.chat_id} browser=${runtime.name} pane=${item.pane_order}`);
      }

      focus.pageFocusAt.set(page, item.focused_at);
      focusCandidates.push({ runtime, page, focusedAt: item.focused_at });
      runtime.activePage = page;
      await recordChatBrowser(sql, item.chat_id, runtime.name);
    }
  }

  // Restore focus after all contexts have been opened so page focus events from
  // intermediate navigations cannot override the persisted cross-browser target.
  const lastFocused = focusCandidates.sort((a, b) => b.focusedAt - a.focusedAt)[0];
  if (lastFocused) {
    setVirtualFocus(focus, lastFocused.runtime, lastFocused.page, "ctl");
    log.info(`[watch] restored virtual focus chat=${normalizeUuid(lastFocused.page.url())} browser=${lastFocused.runtime.name}`);
  }
  return restoredCount;
}

async function ensureRetrySchema(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chat_retry_settings (
      chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function isAutoRetryEnabled(sql: Sql, chatId: string): Promise<boolean> {
  const rows = await sql`
    SELECT enabled FROM chat_retry_settings WHERE chat_id = ${chatId}::uuid
  `;
  return rows.length > 0 && Boolean(rows[0]!.enabled);
}

/** Click only the last visible exact-name Retry button, which is the end-of-thread action. */
async function clickRetryAtConversationEnd(page: Page, chatId: string): Promise<boolean> {
  if (normalizeUuid(page.url()) !== chatId) return false;
  const buttons = page.getByRole("button", { name: "Retry", exact: true });
  const count = await buttons.count();
  for (let index = count - 1; index >= 0; index--) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    if (!(await button.isEnabled().catch(() => false))) continue;
    await button.click({ timeout: 3000 });
    log.info(`[retry] clicked end-of-conversation Retry button for chat=${chatId}`);
    return true;
  }
  return false;
}

/** Recover the exact ChatGPT delivery-timeout alert, not unrelated Retry controls. */
async function retryTimedOutDelivery(page: Page, chatId: string): Promise<boolean> {
  if (normalizeUuid(page.url()) !== chatId) return false;
  const alert = page.locator('main:visible [role="alert"]:visible')
    .filter({ hasText: "Message delivery timed out. Please try again." });
  const count = await alert.count();
  for (let index = count - 1; index >= 0; index--) {
    const candidate = alert.nth(index);
    const body = (await candidate.innerText().catch(() => "")).trim();
    if (!body.includes("Message delivery timed out. Please try again.")) continue;
    const button = candidate.getByRole("button", { name: "Retry", exact: true });
    if (await button.count() !== 1 || !(await button.isVisible()) || !(await button.isEnabled())) continue;
    await button.click({ timeout: 3000 });
    log.info(`[retry] clicked delivery-timeout Retry for chat=${chatId}`);
    return true;
  }
  return false;
}

async function hasTimedOutDelivery(page: Page, chatId: string): Promise<boolean> {
  if (normalizeUuid(page.url()) !== chatId) return false;
  return page.locator('main:visible [role="alert"]:visible')
    .filter({ hasText: "Message delivery timed out. Please try again." })
    .count().then((count) => count > 0).catch(() => false);
}

async function ensureHookSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chat_hooks (
      chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      folder text NOT NULL,
      child_folder text NOT NULL DEFAULT '.',
      nix_flake boolean NOT NULL DEFAULT false,
      clipboard_command jsonb NOT NULL DEFAULT '["wl-paste", "-n"]'::jsonb,
      build_command text DEFAULT 'wcc build',
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Keep existing installations compatible; this is a non-destructive additive migration.
  await sql.unsafe("ALTER TABLE chat_hooks ADD COLUMN IF NOT EXISTS build_command text DEFAULT 'wcc build'");
}

async function loadChatHook(sql: Sql, chatId: string): Promise<ChatHook | null> {
  const rows = await sql`
    SELECT folder, child_folder, nix_flake, clipboard_command, enabled, build_command
    FROM chat_hooks WHERE chat_id = ${chatId}::uuid
  `;
  if (!rows.length) return null;
  const row = rows[0] as any;
  const command = typeof row.clipboard_command === "string"
    ? JSON.parse(row.clipboard_command)
    : row.clipboard_command;
  return {
    folder: row.folder,
    child_folder: row.child_folder || ".",
    nix_flake: Boolean(row.nix_flake),
    clipboard_command: Array.isArray(command) && command.length ? command : ["wl-paste", "-n"],
    build_command: row.build_command == null ? null : String(row.build_command),
    enabled: Boolean(row.enabled),
  };
}

async function migrate(cfg: Config) {
  const sql = openDb(cfg);
  try {
    const schemaPath = path.resolve(import.meta.dir, "../sql/schema.sql");
    const schema = await readFile(schemaPath, "utf8");
    // pg_trgm is optional; apply main statements, ignore extension errors for trgm index
    try {
      await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    } catch (e) {
      log.warn(`[db] pg_trgm not available (title fuzzy search disabled): ${e}`);
    }
    await sql.unsafe(schema);
    log.info("[db] schema applied");
  } finally {
    await sql.end();
  }
}

/** TRUNCATE chats + messages. Host-only; no Nix. Uses CHATGPT_DATABASE_URL / config. */
async function flush(cfg: Config) {
  const sql = openDb(cfg);
  try {
    const flushPath = path.resolve(import.meta.dir, "../sql/flush.sql");
    const body = await readFile(flushPath, "utf8");
    await sql.unsafe(body);
    log.info("[db] flushed (TRUNCATE messages, chats)");
  } finally {
    await sql.end();
  }
}

async function upsertChat(sql: Sql, chat: ScrapedChat, browserName = "default"): Promise<void> {
  const chatId = normalizeUuid(chat.id);
  if (!chatId) throw new Error(`upsertChat: invalid chat id "${chat.id}"`);
  await sql`
    INSERT INTO chats (id, title, url, updated_at, last_message_at)
    VALUES (${chatId}::uuid, ${chat.title}, ${chat.url}, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = COALESCE(NULLIF(EXCLUDED.title, ''), chats.title),
      url = COALESCE(EXCLUDED.url, chats.url),
      updated_at = NOW(),
      last_message_at = NOW()
  `;
  await recordChatBrowser(sql, chatId, browserName);
}

/** Synchronize sidebar metadata without making every chat look newly active. */
async function upsertSidebarChats(sql: Sql, chats: SidebarChat[], browserName = "default"): Promise<void> {
  for (const chat of chats) {
    await sql`
      INSERT INTO chats (id, title, url, updated_at)
      VALUES (${chat.id}::uuid, ${chat.title}, ${chat.url}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        url = EXCLUDED.url,
        updated_at = CASE
          WHEN chats.title IS DISTINCT FROM EXCLUDED.title THEN NOW()
          ELSE chats.updated_at
        END
    `;
    await recordChatBrowser(sql, chat.id, browserName);
  }
}

/**
 * Persist a message only when something meaningful changed.
 * `completed` is monotonic in the database: once true, a transient scrape that
 * sees it as false must not reopen the row. `completed_at` is stamped only on
 * the false -> true transition. Comparing it to statement_timestamp() in the
 * RETURNING clause identifies that transition for this statement only; unlike
 * comparing it with first_seen_at, the condition cannot stay true forever.
 */
async function upsertMessage(sql: Sql, chatId: string, msg: ScrapedMessage): Promise<"inserted" | "updated" | "completed"> {
  const mid = normalizeUuid(msg.id);
  const cid = normalizeUuid(chatId);
  if (!mid || !cid) {
    log.warn(`[db] skip message with invalid uuid msg="${msg.id}" chat="${chatId}"`);
    return "updated";
  }
  const rows = await sql`
    INSERT INTO messages (id, chat_id, role, content, sequence, completed, completed_at, created_at)
    VALUES (
      ${mid}::uuid,
      ${cid}::uuid,
      ${msg.role},
      ${msg.content},
      ${msg.sequence},
      ${msg.completed},
      ${msg.completed ? sql`NOW()` : null},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content,
      sequence = EXCLUDED.sequence,
      completed = messages.completed OR EXCLUDED.completed,
      completed_at = CASE
        WHEN messages.completed = false AND EXCLUDED.completed = true THEN statement_timestamp()
        ELSE messages.completed_at
      END
    -- Avoid touching the same completed history rows on every poll. This also
    -- prevents needless WAL/index churn for long conversations.
    WHERE messages.content IS DISTINCT FROM EXCLUDED.content
       OR messages.sequence IS DISTINCT FROM EXCLUDED.sequence
       OR (messages.completed = false AND EXCLUDED.completed = true)
    RETURNING
      (xmax = 0) AS inserted,
      (completed AND completed_at = statement_timestamp()) AS just_completed
  `;
  const row = rows[0] as { inserted: boolean; just_completed: boolean } | undefined;
  if (!row) return "updated";
  if (row.inserted) return msg.completed ? "completed" : "inserted";
  if (row.just_completed) return "completed";
  return "updated";
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

async function launchContext(
  cfg: Config,
  configPath: string,
  headless: boolean,
  browserName = "default"
): Promise<BrowserContext> {
  const executablePath = await resolveBrowserExecutable(cfg, configPath);
  const profileDir = resolveBrowserProfileDir(cfg, configPath, browserName);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const nativeWindowViewport = !headless && (cfg.browser?.native_window_viewport ?? true);
  const viewport = nativeWindowViewport
    ? null
    : {
        width: cfg.browser?.viewport_width ?? 1440,
        height: cfg.browser?.viewport_height ?? 900,
      };

  log.info(
    `[browser] profile=${profileDir} headless=${headless} ` +
      `viewport=${nativeWindowViewport ? "native-window" : `${viewport!.width}x${viewport!.height}`} ` +
      `sandbox=${cfg.browser?.chromium_sandbox ?? true} ` +
      `exe=${executablePath}`
  );

  // Match fomo: pass viewport: null for native-window mode (must be null, not
  // undefined — undefined makes Playwright use the default 1280x720 viewport).
  try {
    return await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless,
      // Playwright defaults this to false and injects --no-sandbox. Keep the
      // Chromium sandbox enabled unless explicitly disabled in config.
      chromiumSandbox: cfg.browser?.chromium_sandbox ?? true,
      viewport, // null | { width, height }
    });
  } catch (error) {
    throw new Error(
      `Failed to launch ${executablePath}\n${formatError(error)}`,
      { cause: error }
    );
  }
}

async function getPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  if (pages.length > 0) return pages[0]!;
  return context.newPage();
}

function attachNetworkDebug(page: Page, cfg: Config) {
  if (!cfg.debug?.network) return;
  page.on("request", (req) => {
    if (req.url().includes("backend-api") || req.url().includes("conversation")) {
      log.debug(`[net] → ${req.method()} ${req.url().slice(0, 120)}`);
    }
  });
  page.on("response", (res) => {
    if (res.url().includes("backend-api") || res.url().includes("conversation")) {
      log.debug(`[net] ← ${res.status()} ${res.url().slice(0, 120)}`);
    }
  });
}


/** Extract a canonical UUID from strings like "local-chatgpt:f08711aa-…" or raw uuids. */
function normalizeUuid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  return m ? m[0]!.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// DOM scraping (ChatGPT / Codex UI, based on provided outerHTML sample)
// ---------------------------------------------------------------------------

/**
 * Read chat IDs and titles from the sidebar. When scrollAll is true, scroll the
 * virtualized history list to the end so chats outside the viewport are loaded.
 */
async function scrapeSidebarChats(page: Page, scrollAll = false): Promise<SidebarChat[]> {
  return await page.evaluate(async (shouldScroll) => {
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const chats = new Map<string, { id: string; title: string; url: string }>();
    const links = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'));

    const collect = () => {
      for (const link of links()) {
        const match = link.getAttribute("href")?.match(uuidRe);
        if (!match) continue;
        const id = match[0].toLowerCase();
        const titleNode = link.querySelector("[data-thread-title]");
        const title = (
          titleNode?.textContent ||
          link.getAttribute("aria-label") ||
          link.textContent ||
          ""
        ).replace(/\s+/g, " ").trim();
        if (!title) continue;
        chats.set(id, { id, title, url: new URL(link.href, location.origin).toString() });
      }
    };

    collect();
    if (!shouldScroll || links().length === 0) return Array.from(chats.values());

    let scroller: HTMLElement | null = null;
    let node: HTMLElement | null = links()[0]!;
    while (node) {
      const style = getComputedStyle(node);
      if (
        node.scrollHeight > node.clientHeight + 20 &&
        /(auto|scroll)/.test(style.overflowY)
      ) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    if (!scroller) return Array.from(chats.values());

    const originalTop = scroller.scrollTop;
    let stableBottomPasses = 0;
    let previousSize = -1;
    scroller.scrollTop = 0;

    for (let pass = 0; pass < 200 && stableBottomPasses < 3; pass++) {
      collect();
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      stableBottomPasses = atBottom && chats.size === previousSize
        ? stableBottomPasses + 1
        : 0;
      previousSize = chats.size;
      if (stableBottomPasses >= 2) break;
      scroller.scrollTop = Math.min(
        scroller.scrollTop + Math.max(200, scroller.clientHeight * 0.8),
        scroller.scrollHeight
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    collect();
    scroller.scrollTop = originalTop;
    return Array.from(chats.values());
  }, scrollAll);
}

async function syncSidebarChats(page: Page, sql: Sql, scrollAll = false, browserName = "default"): Promise<SidebarChat[]> {
  const chats = await scrapeSidebarChats(page, scrollAll);
  await upsertSidebarChats(sql, chats, browserName);
  return chats;
}

/**
 * Extract the currently open conversation from the page.
 *
 * Selectors derived from the sample HTML:
 *   - conversation id: data-chatgpt-selection-conversation-id / URL /c/{uuid}
 *   - user bubbles:    [data-user-message-bubble="true"]  or  .group\/user-message
 *   - assistant:       [data-conversation-role="assistant"] ancestors
 *   - message ids:     data-chatgpt-search-message-ids
 *   - streaming:       presence of "Stop generating" / stop button, or
 *                      "Worked for …" unfinished state is NOT used; we look for
 *                      the stop-generating control or aria-busy style signals
 */
async function scrapeCurrentChat(page: Page): Promise<ScrapedChat | null> {
  return await page.evaluate(() => {
    const uuidRe =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const extractUuid = (s: string | null | undefined): string => {
      if (!s) return "";
      const m = String(s).match(uuidRe);
      return m ? m[0]!.toLowerCase() : "";
    };

    // --- conversation id: URL first (stable), then page attributes ---
    let chatId = "";
    const pathMatch = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (pathMatch) chatId = extractUuid(pathMatch[1]);

    if (!chatId) {
      // Prefer the message thread area over floating/sidebar clones
      const thread = Array.from(document.querySelectorAll("main")).find((main) =>
        main.getClientRects().length > 0 && getComputedStyle(main).visibility !== "hidden"
      ) || document.body;
      const sel = thread.querySelector("[data-chatgpt-selection-conversation-id]");
      if (sel) {
        chatId = extractUuid(sel.getAttribute("data-chatgpt-selection-conversation-id"));
      }
    }
    if (!chatId) chatId = extractUuid(location.href);
    if (!chatId) return null;

    // --- title ---
    let title = (document.title || "").replace(/\s*[|·]\s*ChatGPT.*$/i, "").trim();
    // Sidebar active row often has the real title
    const activeNav =
      document.querySelector('[aria-current="page"]') ||
      document.querySelector("a[href*='/c/" + chatId + "']");
    if (activeNav?.textContent?.trim()) {
      const t = activeNav.textContent.trim().split("\n")[0]!.trim();
      if (t && t.length < 200) title = t;
    }

    // --- streaming? ---
    const stopBtn =
      document.querySelector('button[aria-label*="Stop" i]') ||
      Array.from(document.querySelectorAll("button")).find((b) =>
        /stop generating/i.test(b.textContent || "")
      );
    const isStreaming = Boolean(stopBtn);

    // --- messages: only nodes belonging to this conversation ---
    const messages: Array<{
      id: string;
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      sequence: number;
      completed: boolean;
    }> = [];

    const seenIds = new Set<string>();
    let seq = 0;

    // Units that carry message ids. Filter by conversation when attribute present.
    // The browser UI mounts previous/alternate conversation surfaces behind
    // display:none. Only scrape the visible thread: hidden clones can contain
    // incomplete message markup and can win UUID de-duplication otherwise.
    const visibleMain = Array.from(document.querySelectorAll("main")).find((main) =>
      main.getClientRects().length > 0 && getComputedStyle(main).visibility !== "hidden" &&
      main.querySelector("[data-chatgpt-search-message-ids]")
    );
    const messageRoot = visibleMain || document;
    const messageNodes = Array.from(
      messageRoot.querySelectorAll("[data-chatgpt-search-message-ids]")
    ).filter((node) => {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden") return false;
      const owner =
        node.closest("[data-chatgpt-selection-conversation-id]") ||
        node.querySelector("[data-chatgpt-selection-conversation-id]");
      if (!owner) return true; // no owner attr → keep (legacy)
      const oid = extractUuid(
        owner.getAttribute("data-chatgpt-selection-conversation-id")
      );
      // If owner has a different conversation id, skip
      return !oid || oid === chatId;
    });

    for (const node of messageNodes) {
      const idsAttr = node.getAttribute("data-chatgpt-search-message-ids") || "";
      const ids = idsAttr
        .split(/\s+/)
        .map((x) => extractUuid(x))
        .filter(Boolean);
      const id = ids[0];
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const unitKey =
        node.getAttribute("data-content-search-unit-key") ||
        node.getAttribute("data-chatgpt-search-unit-key") ||
        node.closest("[data-content-search-unit-key], [data-chatgpt-search-unit-key]")?.getAttribute("data-content-search-unit-key") ||
        node.closest("[data-chatgpt-search-unit-key]")?.getAttribute("data-chatgpt-search-unit-key") ||
        "";
      let role: "user" | "assistant" | "system" | "tool" = "assistant";
      if (
        /:user$/i.test(unitKey) ||
        node.querySelector("[data-user-message-bubble]") ||
        node.closest(".group\\/user-message")
      ) {
        role = "user";
      } else if (
        /:assistant$/i.test(unitKey) ||
        node.getAttribute("data-conversation-role") === "assistant" ||
        node.closest("[data-conversation-role='assistant']") ||
        node.querySelector('[data-markdown-text-style="assistant-message"]')
      ) {
        role = "assistant";
      }

      // Content: user pre-wrap, assistant markdown root, then fallbacks
      let content = "";
      const preWrap = node.querySelector(
        ".whitespace-pre-wrap, [class*='whitespace-pre-wrap']"
      );
      const markdown = node.querySelector(
        '[data-markdown-text-style="assistant-message"], [class*="MarkdownRoot"]'
      );
      const bubble = node.querySelector(
        "[data-user-message-bubble] .text-size-chat, [data-user-message-bubble]"
      );
      const candidate = (role === "user" ? preWrap || bubble : markdown || preWrap) || node;
      content = (candidate.textContent || "").trim();

      // Drop UI chrome noise that often prefixes assistant blocks
      content = content.replace(/^ChatGPT said:\s*/i, "").trim();
      if (!content) continue;

      const turnMatch = unitKey.match(/(?:fallback-)?turn[-_](\d+)/i);
      messages.push({
        id,
        role,
        content,
        sequence: seq++,
        ...(turnMatch ? { turnOrder: Number(turnMatch[1]) } : {}),
        completed: !isStreaming,
      });
    }

    if (isStreaming && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "assistant") {
          messages[i]!.completed = false;
          break;
        }
      }
    }

    return {
      id: chatId,
      title: title || chatId,
      url: location.href,
      messages,
      isStreaming,
    };
  });
}

/**
 * Bring a newly opened conversation to its end and wait for React hydration,
 * message history and any initial generation to settle. Hooks must not inspect
 * a pane until this has completed.
 */
async function waitForConversationReady(
  page: Page,
  chatId: string,
  timeoutMs = 45_000
): Promise<ScrapedChat> {
  const deadline = Date.now() + timeoutMs;
  await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 15_000) }).catch(() => undefined);
  // ChatGPT may keep hidden/inert previous surfaces mounted during navigation.
  // Never wait on `.first()` here: it can point to a permanently hidden main.
  await page.locator("main:visible").first()
    .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });
  await page.locator('#prompt-textarea:visible, [data-composer-markdown][contenteditable="true"]:visible, [contenteditable="true"][role="textbox"]:visible, textarea:visible').first()
    .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });

  let previousSignature = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    // ChatGPT's scrollable thread container differs between UI revisions.
    // Move every scrollable descendant of main to its end, plus the document.
    await page.evaluate(() => {
      const roots = Array.from(document.querySelectorAll<HTMLElement>("main"));
      for (const root of roots) {
        if (!root.getClientRects().length || getComputedStyle(root).visibility === "hidden") continue;
        for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
          if (element.scrollHeight > element.clientHeight + 80) element.scrollTop = element.scrollHeight;
        }
      }
      const scrolling = document.scrollingElement;
      if (scrolling) scrolling.scrollTop = scrolling.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => undefined);
    await page.waitForTimeout(500);

    const snapshot = await scrapeCurrentChat(page).catch(() => null);
    if (!snapshot || snapshot.id !== chatId || snapshot.messages.length === 0 || snapshot.isStreaming) {
      previousSignature = "";
      stableSamples = 0;
      continue;
    }
    const signature = JSON.stringify(snapshot.messages.map((message) => [
      message.id, message.role, message.content.length, message.completed, message.turnOrder ?? null,
    ]));
    if (signature === previousSignature) stableSamples++;
    else stableSamples = 0;
    previousSignature = signature;
    // Three equal snapshots over ~1.5s avoids treating an early partial render
    // as the baseline while older turns or attachment controls are still mounting.
    if (stableSamples >= 3) return snapshot;
  }
  throw new Error(`conversation ${chatId} did not finish loading within ${timeoutMs}ms`);
}

function configurePage(page: Page, cfg: Config) {
  page.setDefaultTimeout(cfg.browser?.selector_timeout_ms ?? 20_000);
  page.setDefaultNavigationTimeout(cfg.browser?.navigation_timeout_ms ?? 45_000);
}

async function openChatGPT(page: Page, cfg: Config) {
  const timeout = cfg.browser?.navigation_timeout_ms ?? 45_000;
  configurePage(page, cfg);

  let target = cfg.chatgpt.url;
  if (cfg.chatgpt.conversation_id) {
    const id = cfg.chatgpt.conversation_id.replace(/^\/c\//, "");
    target = new URL(`/c/${id}`, cfg.chatgpt.url).toString();
  }

  log.info(`[nav] goto ${target}`);
  await page.goto(target, { waitUntil: "domcontentloaded", timeout });
  // Allow React hydration
  await page.waitForTimeout(1500);
}

/** Keep an existing ChatGPT tab/current chat; only navigate fresh or foreign tabs. */
async function ensureCurrentChatGPTPage(page: Page, cfg: Config) {
  configurePage(page, cfg);
  const configured = new URL(cfg.chatgpt.url);
  const current = page.url();
  if (!current.startsWith(`${configured.origin}/`)) {
    await page.goto(cfg.chatgpt.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  }
}

async function syncChatsCommand(cfg: Config, configPath: string, quiet = false) {
  try {
    const response = await fetch(`http://${CONTROL_HOST}:${CONTROL_PORT}/sync-chats`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    if (response.ok) {
      const result = await response.json() as { total?: number; browsers?: Array<{ browser_name: string; count: number }> };
      if (!quiet) for (const browser of result.browsers ?? []) console.log(`${browser.browser_name}\t${browser.count} chats synchronized`);
      log.info(`[chats] refreshed ${result.total ?? 0} sidebar chats through the running multi-browser watcher`);
      return;
    }
    if (response.status !== 404) throw new Error(await response.text());
  } catch (error) {
    if (error instanceof Error && !/fetch failed|ECONNREFUSED|Failed to fetch/i.test(error.message)) throw error;
  }
  const sql = openDb(cfg);
  const profiles = await discoverBrowserProfiles(cfg, configPath);
  let total = 0;
  try {
    await ensureBrowserSchema(sql);
    for (const profile of profiles) {
      await registerBrowser(sql, profile);
      const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false, profile.name);
      try {
        const page = await getPage(context);
        attachNetworkDebug(page, cfg);
        await ensureCurrentChatGPTPage(page, cfg);
        const chats = await syncSidebarChats(page, sql, true, profile.name);
        total += chats.length;
        if (!quiet) {
          for (const chat of chats) console.log(`${profile.name}\t${chat.id}\t${chat.title}`);
        }
        log.info(`[chats] browser=${profile.name} synchronized ${chats.length} sidebar chats`);
      } finally {
        await context.close();
      }
    }
    log.info(`[chats] synchronized ${total} sidebar chat rows across ${profiles.length} browser profile(s)`);
  } finally {
    await sql.end();
  }
}

/** Legacy one-shot open is intentionally routed through the watch control server. */
async function openChatCommand(_cfg: Config, _configPath: string, rawId: string) {
  const chatId = normalizeUuid(rawId);
  if (!chatId) throw new Error(`open: invalid chat id "${rawId}"`);
  const response = await fetch(
    `http://${CONTROL_HOST}:${CONTROL_PORT}/open`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
    }
  );
  const result = await response.json().catch(() => ({})) as { error?: string; url?: string; browser_name?: string; already_open?: boolean };
  if (!response.ok) {
    throw new Error(result.error || `watch control server returned ${response.status}; start \`bun run watch\` first`);
  }
  console.log(`${result.already_open ? "focused" : "opened"} ${chatId} in browser ${result.browser_name || "default"} (${result.url || "ChatGPT"})`);
}

async function sendMessageCommand(
  _cfg: Config,
  _configPath: string,
  text: string,
  files: string[],
  draft = false
) {
  if (!text.trim() && files.length === 0) {
    throw new Error("send: provide message text or at least one file");
  }
  const resolvedFiles = files.map((file) => path.resolve(file));
  for (const file of resolvedFiles) await access(file, constants.R_OK);
  const response = await fetch(`http://${CONTROL_HOST}:${CONTROL_PORT}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, files: resolvedFiles, draft }),
  });
  const result = await response.json().catch(() => ({})) as { error?: string; chat_id?: string; browser_name?: string };
  if (!response.ok) throw new Error(result.error || `watch control server returned ${response.status}; start \`bun run watch\` first`);
  log.info(`[send] ${draft ? "draft prepared (not submitted)" : "submitted"} in browser=${result.browser_name ?? "virtual-focus"} chat=${result.chat_id ?? "current"}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function doctor(cfg: Config, configPath: string) {
  log.info(`[doctor] bun=${Bun.version} platform=${process.platform} arch=${process.arch}`);
  log.info(`[doctor] config=${configPath}`);
  log.info(`[doctor] nixos=${await isNixOS()}`);
  log.info(`[doctor] configured executable=${cfg.browser?.executable_path || "(auto)"}`);

  const executablePath = await resolveBrowserExecutable(cfg, configPath);
  log.info(`[doctor] selected browser=${executablePath}`);
  log.info(`[doctor] chromium sandbox=${cfg.browser?.chromium_sandbox ?? true}`);
  const version = await commandOutput([executablePath, "--version"]);
  log.info(`[doctor] browser --version exit=${version.code} ${version.stdout || version.stderr}`);

  log.info("[doctor] attempting Playwright headless launch...");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: cfg.browser?.chromium_sandbox ?? true,
  });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>ok</title>");
    log.info(`[doctor] launch OK; title=${await page.title()}`);
  } finally {
    await browser.close();
  }

  const sql = openDb(cfg);
  try {
    const rows = await sql`SELECT current_database() AS db, current_user AS usr, NOW() AS ts`;
    log.info(`[doctor] db ok database=${rows[0]?.db} user=${rows[0]?.usr}`);
  } catch (e) {
    log.error(`[doctor] db FAILED: ${formatError(e)}`);
    throw e;
  } finally {
    await sql.end();
  }

  log.info("[doctor] OK");
}

/**
 * Launch a NORMAL Chromium (no Playwright automation) so the user can log in.
 * Cookies / local storage land in profile_dir and are reused by watch/dump.
 */
async function login(cfg: Config, configPath: string, browserName = "default") {
  browserName = normalizeBrowserName(browserName);
  const executablePath = await resolveBrowserExecutable(cfg, configPath);
  const profileDir = resolveBrowserProfileDir(cfg, configPath, browserName);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  log.info(`[login] browser=${executablePath}`);
  log.info(`[login] browser-name=${browserName}`);
  log.info(`[login] profile=${profileDir}`);
  log.info("[login] launching a NORMAL Chromium process (no Playwright/CDP automation)");
  log.info("[login] sign into ChatGPT, open any chat, then CLOSE this Chromium window.");
  log.info("[login] this command will finish when the browser exits.\n");

  const proc = Bun.spawn(
    [
      executablePath,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      cfg.chatgpt.url,
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    }
  );

  const code = await proc.exited;
  if (code !== 0) throw new Error(`Manual Chromium login process exited with code ${code}`);
  log.info(`[login] browser closed; profile saved: ${profileDir}`);
  log.info("[login] next: bun run watch; all registered profiles are loaded automatically");
}

async function dump(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
  await ensureBrowserSchema(sql);
  const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false);
  try {
    const page = await getPage(context);
    attachNetworkDebug(page, cfg);
    await openChatGPT(page, cfg);
    await syncSidebarChats(page, sql, true);
    const chat = await scrapeCurrentChat(page);
    if (!chat) {
      log.warn("[dump] no conversation detected on the page — are you logged in?");
      return;
    }
    log.info(`[dump] chat=${chat.id} title="${chat.title}" messages=${chat.messages.length}`);
    await upsertChat(sql, chat);
    for (const msg of chat.messages) {
      const status = await upsertMessage(sql, chat.id, msg);
      log.info(
        `[dump] ${status} ${msg.role} seq=${msg.sequence} id=${msg.id.slice(0, 8)}… ` +
          `completed=${msg.completed} chars=${msg.content.length}`
      );
    }
  } finally {
    await context.close();
    await sql.end();
  }
}

async function persistChat(sql: Sql, chat: ScrapedChat, settleMs: number, prevIncomplete: Map<string, number>, browserName = "default"): Promise<Set<string>> {
  await upsertChat(sql, chat, browserName);
  const newlyCompletedAssistantMessages = new Set<string>();
  for (const msg of chat.messages) {
    // Debounce completion: if just flipped to completed, wait settleMs
    if (msg.completed && prevIncomplete.has(msg.id)) {
      const firstIncompleteAt = prevIncomplete.get(msg.id)!;
      if (Date.now() - firstIncompleteAt < settleMs) {
        // still within settle window — treat as incomplete for this tick
        msg.completed = false;
      }
    }
    if (!msg.completed) {
      if (!prevIncomplete.has(msg.id)) prevIncomplete.set(msg.id, Date.now());
    } else {
      prevIncomplete.delete(msg.id);
    }

    const status = await upsertMessage(sql, chat.id, msg);
    if (msg.role === "assistant" && msg.completed && (status === "inserted" || status === "completed")) {
      newlyCompletedAssistantMessages.add(msg.id);
    }
    if (status === "inserted" || status === "completed") {
      log.info(
        `[persist] ${status} chat=${chat.id.slice(0, 8)} ${msg.role} ` +
          `seq=${msg.sequence} id=${msg.id.slice(0, 8)}… chars=${msg.content.length}`
      );
    }
  }
  return newlyCompletedAssistantMessages;
}

async function once(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
  await ensureBrowserSchema(sql);
  const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false);
  const settleMs = cfg.chatgpt.complete_settle_ms ?? 800;
  try {
    const page = await getPage(context);
    attachNetworkDebug(page, cfg);
    await openChatGPT(page, cfg);
    await syncSidebarChats(page, sql, true);
    const chat = await scrapeCurrentChat(page);
    if (!chat) {
      log.warn("[once] no conversation on page");
      return;
    }
    await persistChat(sql, chat, settleMs, new Map());
  } finally {
    await context.close();
    await sql.end();
  }
}


const CONTROL_HOST = process.env.CHATGPT_CTL_HOST || "127.0.0.1";
const CONTROL_PORT = Number(process.env.CHATGPT_CTL_PORT || 17381);

function safeFilename(raw: string): string {
  const leaf = path.basename(raw.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  return leaf && leaf.toLowerCase().endsWith(".zip") ? leaf : `${leaf || "chatgpt-download"}.zip`;
}

type ZipTarget = { index: number; label: string; selector: string; kind: "link" | "card"; messageOrder: number | null; messageId: string | null; identity: string };

/**
 * ChatGPT renders assistant-generated files as DIL pressables (`role=link`),
 * not ordinary <a href> elements. User-uploaded files use resource-card
 * buttons. Keep ordinary anchors as a fallback for older ChatGPT builds.
 */
async function findZipTargets(page: Page): Promise<ZipTarget[]> {
  const selector = 'a[href], [role="link"][aria-label], button[aria-label]';
  return page.locator(selector).evaluateAll((elements) => {
    const result: ZipTarget[] = [];
    elements.forEach((element, index) => {
      const el = element as HTMLElement;
      const aria = el.getAttribute("aria-label") || "";
      const downloadName = el.getAttribute("download") || "";
      const title = el.getAttribute("title") || "";
      const href = el instanceof HTMLAnchorElement ? el.href : "";
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      const isLink = el instanceof HTMLAnchorElement || el.getAttribute("role") === "link";
      const context = `${aria} ${downloadName} ${title} ${text} ${href}`;
      const hasZipExtension = /\.zip(?:$|[?#\s])/i.test(context);
      // DIL download pressables sometimes expose only a descriptive label such
      // as "Open Download the repaired full project ZIP", with no filename.
      // Include those links; the browser Download event supplies the real name.
      const isDescriptiveZipLink = isLink && /\bzip\b/i.test(`${aria} ${title} ${text}`);
      // Generated sandbox files expose a DIL pressable with aria-label
      // "Open Download <display name>" and often omit both the .zip suffix
      // and the word ZIP (e.g. "Download updated Watcher — v3").
      // Only accept a download-like link, then verify ZIP magic after clicking.
      const isGeneratedDownload = isLink && /^Open\s+Download\b/i.test(aria);
      if (!hasZipExtension && !isDescriptiveZipLink && !isGeneratedDownload) return;

      const label = [aria, downloadName, title, text].find((value) => /\.zip(?:$|[?#\s])/i.test(value))
        || aria || downloadName || title || text || href;
      // ChatGPT's conversation DOM is not guaranteed to be chronological.
      // DIL attachment nodes can be nested in portals, so inspect all ancestors
      // for either of the conversation search-unit attributes.
      let ancestor: HTMLElement | null = el;
      let messageOrder: number | null = null;
      // Prefer the same message UUID used by the history scraper. This makes
      // attachment identity independent of DOM order and repeated scans.
      const messageUnit = el.closest("[data-chatgpt-search-message-ids]");
      const rawMessageIds = messageUnit?.getAttribute("data-chatgpt-search-message-ids") || "";
      let messageId = rawMessageIds.split(/\s+/).map((value) =>
        value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || ""
      ).find(Boolean) || "";
      while (ancestor) {
        // Older ChatGPT DOM variants may not expose the search-message id.
        // Fall back to stable message metadata, never to a volatile element index.
        if (!messageId) {
          const fallbackId =
            ancestor.getAttribute("data-dil-message-id") ||
            ancestor.getAttribute("data-dil-source-message-id") ||
            ancestor.getAttribute("data-chatgpt-selection-message-id") || "";
          messageId = fallbackId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
        }
        if (messageOrder === null) {
          const keys = [
            ancestor.getAttribute("data-content-search-unit-key") || "",
            ancestor.getAttribute("data-chatgpt-search-unit-key") || "",
          ];
          for (const key of keys) {
            const match = key.match(/(?:fallback-)?turn[-_](\d+)/i);
            if (match) {
              messageOrder = Number(match[1]);
              break;
            }
          }
        }
        ancestor = ancestor.parentElement;
      }
      const cleanLabel = label.replace(/^Open\s+Download\s+/i, "").trim();
      const stableMessageId = messageId.toLowerCase();
      result.push({
        index,
        label: cleanLabel,
        selector,
        kind: isLink ? "link" : "card",
        messageOrder,
        messageId: stableMessageId || null,
        identity: `${stableMessageId || `turn-${messageOrder ?? "unknown"}`}|${cleanLabel}`,
      });
    });
    return result;
  });
}

async function waitForDownload(click: () => Promise<unknown>, page: Page): Promise<Download | null> {
  // Attach the listener before clicking. A timeout is a recoverable UI race,
  // not a fatal watcher error; importantly, it must never cause a second,
  // unscoped click on an arbitrary button elsewhere in the page.
  const downloadPromise = page.waitForEvent("download", { timeout: 12_000 }).then(
    (download) => download,
    () => null,
  );
  await click();
  return await downloadPromise;
}

async function downloadZipTarget(page: Page, targetInfo: ZipTarget, directory: string): Promise<string | null> {
  await mkdir(directory, { recursive: true });
  // Re-resolve the attachment immediately before interaction. A DOM index
  // captured during an earlier poll can point at an unrelated button after
  // streaming/layout changes, so only click a currently matching identity.
  const currentTargets = await findZipTargets(page);
  const currentMatches = currentTargets.filter((candidate) => candidate.identity === targetInfo.identity);
  if (currentMatches.length !== 1) {
    log.warn(`[download] target '${targetInfo.label}' is no longer uniquely present; refusing to click`);
    return null;
  }
  const currentTarget = currentMatches[0]!;
  const targetLocator = page.locator(currentTarget.selector).nth(currentTarget.index);
  let download: Download | null;
  try {
    download = await waitForDownload(() => targetLocator.click({ timeout: 5_000 }), page);
  } catch (error) {
    log.warn(`[download] click failed for '${targetInfo.label}': ${formatError(error)}`);
    return null;
  }
  if (!download) {
    log.warn(`[download] no Playwright download event for '${targetInfo.label}'; skipping hook instead of clicking another page button`);
    return null;
  }

  const suggested = download.suggestedFilename() || targetInfo.label || "chatgpt-download.zip";
  log.info(`[download] browser suggested filename='${suggested}' for selected attachment '${targetInfo.label}'`);
  const filename = safeFilename(suggested);
  // Unique staging file prevents concurrent candidates overwriting each other.
  const target = path.join(directory, `${crypto.randomUUID()}-${filename}`);
  await download.saveAs(target);
  // Do not allow a generic "Open Download" pressable to feed a non-ZIP
  // file into a destructive project-update hook.
  const handle = await open(target, "r");
  let magic = Buffer.alloc(4);
  try {
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    if (bytesRead !== 4) magic = Buffer.alloc(0);
  } finally {
    await handle.close();
  }
  if (!(magic.length === 4 && magic[0] === 0x50 && magic[1] === 0x4b &&
    ((magic[2] === 0x03 && magic[3] === 0x04) ||
     (magic[2] === 0x05 && magic[3] === 0x06) ||
     (magic[2] === 0x07 && magic[3] === 0x08)))) {
    await rm(target, { force: true });
    log.warn(`[download] candidate '${targetInfo.label}' is not a ZIP archive; trying other candidates`);
    return null;
  }
  log.info(`[download] saved verified ZIP ${target}`);
  return target;
}

type AssistantZipIdentity = Pick<ScrapedMessage, "id" | "turnOrder">;

function latestAssistantFromMessages(messages: ScrapedMessage[]): ScrapedMessage | undefined {
  const assistants = messages.filter((message) => message.role === "assistant");
  const numberedAssistants = assistants.filter((message) => message.turnOrder !== undefined);
  const candidates = numberedAssistants.length > 0 ? numberedAssistants : assistants;
  return candidates.reduce<ScrapedMessage | undefined>((best, current) => {
    if (!best) return current;
    if (numberedAssistants.length > 0 && best.turnOrder !== current.turnOrder) {
      return (current.turnOrder ?? -1) > (best.turnOrder ?? -1) ? current : best;
    }
    return current.sequence > best.sequence ? current : best;
  }, undefined);
}

async function latestAssistantMessage(page: Page, expectedChatId?: string): Promise<AssistantZipIdentity> {
  const chat = await scrapeCurrentChat(page);
  if (!chat || (expectedChatId && chat.id !== expectedChatId)) {
    throw new Error(`cannot identify the current conversation before ZIP selection (expected ${expectedChatId || "current chat"})`);
  }
  // Prefer the greatest stable turn key whenever ChatGPT exposes one. Mixing
  // known and unknown turn orders in one reduce can let a later sequence
  // number override a newer, explicitly numbered turn.
  const latestAssistant = latestAssistantFromMessages(chat.messages);
  if (!latestAssistant?.id) {
    const roles = chat.messages.map((message) => `${message.role}:${message.id.slice(0, 8)}`).join(", ");
    throw new Error(
      `cannot identify the latest assistant message in ${chat.id}; refusing an older ZIP ` +
      `(scraped ${chat.messages.length} messages: ${roles || "none"}). ` +
      `Check visible conversation message selectors and whether the assistant response is loaded.`
    );
  }
  return { id: latestAssistant.id.toLowerCase(), ...(latestAssistant.turnOrder !== undefined ? { turnOrder: latestAssistant.turnOrder } : {}) };
}

/** Per-chat successful ZIP provenance; written atomically and used only as a hint. */
type SuccessfulZip = { chatId: string; assistantId: string; turnOrder: number | null; targetIdentity: string; label: string; savedAt: string };
const ZIP_HISTORY_FILE = "last-successful-zips.json";

async function loadSuccessfulZips(directory: string): Promise<Record<string, SuccessfulZip>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, ZIP_HISTORY_FILE), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, SuccessfulZip>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`[download] cannot read ZIP history: ${formatError(error)}`);
    }
    return {};
  }
}

async function persistSuccessfulZip(directory: string, chatId: string, assistant: AssistantZipIdentity | undefined, target: ZipTarget): Promise<void> {
  await mkdir(directory, { recursive: true });
  const history = await loadSuccessfulZips(directory);
  history[chatId] = {
    chatId,
    assistantId: assistant?.id ?? target.messageId ?? "",
    turnOrder: assistant?.turnOrder ?? target.messageOrder,
    targetIdentity: target.identity,
    label: target.label,
    savedAt: new Date().toISOString(),
  };
  const temporary = path.join(directory, `.${ZIP_HISTORY_FILE}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path.join(directory, ZIP_HISTORY_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

function explicitZipCandidate(target: ZipTarget): boolean {
  return /\.zip(?:$|[?#\s])/i.test(target.label) || /\bZIP\b/i.test(target.label);
}

async function downloadLastZip(page: Page, directory: string, expectedAssistant?: AssistantZipIdentity): Promise<string> {
  const targets = await findZipTargets(page);
  const chatId = normalizeUuid(page.url());
  if (!chatId) throw new Error("cannot persist ZIP selection without a conversation id");
  const matches = expectedAssistant
    ? targets.filter((target) => zipTargetAssociation(target, expectedAssistant) !== null)
    : targets;
  if (!matches.length) {
    throw new Error(expectedAssistant
      ? `latest assistant message ${expectedAssistant.id} (turn ${expectedAssistant.turnOrder ?? "unknown"}) has no identifiable ZIP attachment; refusing an older message (visible controls: ${targets.length})`
      : "no ZIP download controls found in the current conversation");
  }
  const history = (await loadSuccessfulZips(directory))[chatId];
  // History never authorizes selecting a different/older assistant's attachment.
  // Within the currently authorized set, prioritize candidates newer than the
  // successful turn, then the previously successful label when re-running a turn.
  const candidates = [...matches].sort((a, b) => {
    const prev = history?.turnOrder;
    const aFresh = prev != null && a.messageOrder != null && a.messageOrder > prev ? 1 : 0;
    const bFresh = prev != null && b.messageOrder != null && b.messageOrder > prev ? 1 : 0;
    if (aFresh !== bFresh) return bFresh - aFresh;
    const aKnown = a.identity === history?.targetIdentity || a.label === history?.label ? 1 : 0;
    const bKnown = b.identity === history?.targetIdentity || b.label === history?.label ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    return b.index - a.index;
  });
  const explicit = candidates.filter(explicitZipCandidate);
  // One unmistakable ZIP label: do not click generic "Download" controls.
  const attempts = explicit.length === 1 ? explicit : candidates;
  log.info(`[download] chat=${chatId} candidates=${candidates.length} explicitZIP=${explicit.length} attempts=${attempts.length} lastSuccess=${history?.label ?? "none"}`);
  if (attempts.length === 1) {
    const target = attempts[0]!;
    const archive = await downloadZipTarget(page, target, directory);
    if (!archive) throw new Error(`candidate '${target.label}' did not yield a valid ZIP`);
    await persistSuccessfulZip(directory, chatId, expectedAssistant, target);
    return archive;
  }

  // Each parallel click needs its own Playwright Page and download listener.
  // A shared page would mismatch download events between candidates.
  const limit = Math.min(3, attempts.length);
  let next = 0;
  let winner: { archive: string; target: ZipTarget } | null = null;
  const errors: string[] = [];
  async function worker(): Promise<void> {
    while (!winner && next < attempts.length) {
      const target = attempts[next++]!;
      const tab = await page.context().newPage();
      try {
        await tab.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await waitForConversationReady(tab, chatId, 30_000);
        if (winner) break;
        const archive = await downloadZipTarget(tab, target, directory);
        if (!archive) { errors.push(`${target.label}: no valid ZIP`); continue; }
        if (!winner) winner = { archive, target };
        else await rm(archive, { force: true });
      } catch (error) {
        errors.push(`${target.label}: ${formatError(error)}`);
      } finally {
        await tab.close().catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  const selected = winner as { archive: string; target: ZipTarget } | null;
  if (!selected) throw new Error(`no candidate produced a verified ZIP (${errors.join("; ")})`);
  await persistSuccessfulZip(directory, chatId, expectedAssistant, selected.target);
  return selected.archive;
}

async function sendInPage(page: Page, text: string, chatId?: string, files: string[] = [], submit = true) {
  // This function operates on the watcher's existing page. Do not launch a
  // second browser context: `chatgpt-ctl send` must target the visible chat.
  if (chatId && normalizeUuid(page.url()) !== chatId) {
    await page.goto(new URL(`/c/${chatId}`, "https://chatgpt.com").toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
  }
  // ChatGPT can keep a hidden composer mounted alongside the active one.
  // `.first()` then waits forever on the hidden instance.
  const composer = page.locator('#prompt-textarea:visible, [data-composer-markdown][contenteditable="true"]:visible, [contenteditable="true"][role="textbox"]:visible, textarea:visible').last();
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  if (files.length > 0) {
    const fileInput = page.locator(
      'input[type="file"][aria-label="Attach files" i], ' +
      'input[type="file"]:not([capture]):not([accept*="image" i]):not([accept*="video" i])'
    ).first();
    if (!(await fileInput.count())) throw new Error("send: could not find ChatGPT's file upload input");
    await fileInput.setInputFiles(files);
    await page.waitForTimeout(1000);
  }
  if (text.trim()) await composer.fill(text);
  const sendButtonSelector = 'button[data-testid="send-button"], button[aria-label="Send message" i], button[aria-label="Send" i], button[data-composer-navigation-target="send"]';
  const sendButton = page.locator(sendButtonSelector).first();
  await sendButton.waitFor({ state: "visible", timeout: 8000 });
  if (!submit) {
    // Wait until ChatGPT enables submission (including any asynchronous file
    // upload) but never click it. This leaves a complete, editable draft.
    await page.waitForFunction((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((element) => {
        const button = element as HTMLButtonElement;
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      });
    }, sendButtonSelector, { timeout: 30_000 });
    log.info(`[send] draft prepared text_chars=${text.length} files=${files.length} url=${page.url()}`);
    return;
  }
  await sendButton.click();
  await page.waitForTimeout(700);
  log.info(`[send] submitted text_chars=${text.length} files=${files.length} url=${page.url()}`);
}

async function runHookForZip(
  page: Page,
  chatId: string,
  hook: ChatHook,
  archive: string,
  configPath: string
) {
  const projectDir = resolveFromConfig(configPath, hook.folder);
  await mkdir(projectDir, { recursive: true });
  const listing = await commandOutput(["unzip", "-Z1", archive]);
  if (listing.code !== 0) throw new Error(`cannot list ZIP entries: ${listing.stderr}`);
  const entries = listing.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
  if (!entries.length) throw new Error("ZIP archive is empty");
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.replace(/\\/g, "/"));
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error(`unsafe ZIP entry rejected: ${entry}`);
    }
  }
  const normalizedEntries = entries.map((entry) => path.posix.normalize(entry.replace(/\\/g, "/")));
  const topLevel = new Set(normalizedEntries.map((entry) => entry.split("/")[0]).filter(Boolean));
  const singleRoot = topLevel.size === 1 ? [...topLevel][0]! : null;
  // Auto-hook extraction mirrors `download-last-zip --extract-to`: if every
  // archive entry is inside one top-level directory, merge that directory's
  // contents directly into the configured project folder.
  const flattenRoot = Boolean(singleRoot && normalizedEntries.some((entry) => entry.startsWith(`${singleRoot}/`)));
  let stagedPaths: string[];
  if (flattenRoot && singleRoot) {
    const staging = await mkdtemp(path.join(projectDir, ".chatgpt-ctl-hook-unzip-"));
    try {
      const extract = await commandOutput(["unzip", "-o", "-q", archive, "-d", staging]);
      if (extract.code !== 0) throw new Error(`ZIP extraction failed: ${extract.stderr}`);
      await mergeDirectoryContents(path.join(staging, singleRoot), projectDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    stagedPaths = normalizedEntries
      .map((entry) => entry === singleRoot ? "" : entry.startsWith(`${singleRoot}/`) ? entry.slice(singleRoot.length + 1) : entry)
      .filter(Boolean);
    log.info(`[hook] flattened single root folder '${singleRoot}' into ${projectDir}`);
  } else {
    const extract = await commandOutput(["unzip", "-o", "-q", archive, "-d", projectDir]);
    if (extract.code !== 0) throw new Error(`ZIP extraction failed: ${extract.stderr}`);
    stagedPaths = normalizedEntries;
  }

  // Build before touching the Git index. A failing build must never create a
  // commit for an archive that does not build successfully.
  const buildDir = path.resolve(projectDir, hook.child_folder || ".");
  if (hook.build_command !== null && hook.build_command.trim() !== "") {
    const buildCommand = hook.nix_flake
      ? ["nix", "develop", buildDir, "-c", "sh", "-lc", hook.build_command]
      : ["sh", "-lc", hook.build_command];
    const build = await commandOutput(buildCommand, buildDir);
    log.info(`[hook] build exit=${build.code}${build.stdout ? ` stdout=${build.stdout.slice(-1000)}` : ""}${build.stderr ? ` stderr=${build.stderr.slice(-1000)}` : ""}`);
    if (build.code !== 0) {
      const clipboardCommand = hook.clipboard_command?.length ? hook.clipboard_command : ["wl-paste", "-n"];
      const clipboard = await commandOutput(clipboardCommand);
      const diagnostic = clipboard.stdout || clipboard.stderr || build.stderr || build.stdout || `build command failed with exit code ${build.code}; clipboard was empty`;
      try {
        await sendInPage(page, `Build failed (exit code ${build.code}). No Git commit was created. Latest build output from clipboard:\n\n${diagnostic}`, chatId);
      } catch (sendError) {
        log.error(`[hook] failed to send build diagnostic: ${String(sendError)}`);
      }
      throw new Error(`build failed with exit code ${build.code}; extracted files were kept, Git staging and commit were skipped`);
    }
  } else {
    log.info(`[hook] build command disabled for ${chatId}; skipping build (commit is allowed)`);
  }

  // Stage only actual files supplied by this archive, not directory entries.
  // This avoids explicitly passing an ignored directory (e.g. src/bin) to
  // `git add`, which makes Git exit non-zero even when other files are valid.
  const archiveFiles: string[] = [];
  for (const entry of [...new Set(stagedPaths)]) {
    if (!entry || entry === "." || entry.endsWith("/")) continue; // ZIP directory marker
    const absolute = path.resolve(projectDir, entry);
    const relative = path.relative(projectDir, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`unsafe staged archive path rejected: ${entry}`);
    }
    try {
      const stat = await lstat(absolute);
      if (!stat.isDirectory()) archiveFiles.push(relative.split(path.sep).join("/"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A non-directory ZIP entry removed by the build is still an archive
      // path; keeping it lets `git add -A` stage the resulting deletion.
      archiveFiles.push(relative.split(path.sep).join("/"));
    }
  }

  if (archiveFiles.length === 0) {
    log.info(`[hook] archive contains no stageable files in ${projectDir}`);
    return;
  }

  // Ask Git which archive files are ignored. check-ignore exits 1 when none
  // match, which is a normal result. Tracked files are not reported as ignored.
  const ignoredResult = await commandOutput(
    ["git", "-C", projectDir, "check-ignore", "-z", "--stdin"],
    undefined,
    `${archiveFiles.join("\0")}\0`,
  );
  if (ignoredResult.code !== 0 && ignoredResult.code !== 1) {
    throw new Error(`git check-ignore failed: ${ignoredResult.stderr || ignoredResult.stdout}`);
  }
  const ignored = new Set(ignoredResult.stdout.split("\0").filter(Boolean));
  const stageablePaths = archiveFiles.filter((entry) => !ignored.has(entry));
  const ignoredPaths = archiveFiles.filter((entry) => ignored.has(entry));
  if (ignoredPaths.length > 0) {
    log.info(`[hook] skipping ${ignoredPaths.length} ignored archive path(s): ${ignoredPaths.join(", ")}`);
  }
  if (stageablePaths.length === 0) {
    log.info(`[hook] all ${archiveFiles.length} archive file(s) are ignored; nothing to stage or commit`);
    return;
  }

  // Use literal pathspecs so unusual filenames from an archive cannot be
  // interpreted as Git pathspec magic.
  const pathspecs = stageablePaths.map((entry) => `:(literal)${entry}`);
  const add = await commandOutput(["git", "-C", projectDir, "add", "-A", "--", ...pathspecs]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const staged = await commandOutput(["git", "-C", projectDir, "diff", "--cached", "--quiet", "--", ...pathspecs]);
  if (staged.code === 1) {
    const mdPaths = stageablePaths.filter((entry) => entry.toLowerCase().endsWith(".md"));
    const mdPathspecs = mdPaths.map((entry) => `:(literal)${entry}`);
    const mdDiff = mdPathspecs.length
      ? await commandOutput(["git", "-C", projectDir, "diff", "--cached", "--", ...mdPathspecs])
      : { code: 0, stdout: "", stderr: "" };
    const commitMessage = (mdDiff.stdout || "Auto update").slice(0, 18000);
    const commit = await commandOutput(["git", "-C", projectDir, "commit", "--only", "-m", commitMessage, "--", ...pathspecs]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
    log.info(`[hook] committed ZIP update in ${projectDir}`);
  } else if (staged.code !== 0) {
    throw new Error(`git diff failed: ${staged.stderr}`);
  } else {
    log.info(`[hook] archive produced no Git changes in ${projectDir}`);
  }
}

async function runHookWithLastZip(
  page: Page,
  chatId: string,
  hook: ChatHook,
  cfg: Config,
  configPath: string
): Promise<string> {
  const targetUrl = new URL(`/c/${chatId}`, cfg.chatgpt.url).toString();
  if (normalizeUuid(page.url()) !== chatId) {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: cfg.browser?.navigation_timeout_ms ?? 45_000,
    });
  }
  await waitForConversationReady(page, chatId, cfg.browser?.navigation_timeout_ms ?? 45_000);
  const assistantMessage = await latestAssistantMessage(page, chatId);
  const archiveDir = path.resolve(resolveFromConfig(configPath, hook.folder), ".chatgpt-ctl-downloads");
  const archive = await downloadLastZip(page, archiveDir, assistantMessage);
  await runHookForZip(page, chatId, hook, archive, configPath);
  return archive;
}

function openConversationPages(runtimes: BrowserRuntime[]): Array<{ runtime: BrowserRuntime; page: Page; chatId: string }> {
  const result: Array<{ runtime: BrowserRuntime; page: Page; chatId: string }> = [];
  const seen = new Set<string>();
  for (const runtime of runtimes) {
    for (const page of runtime.context.pages()) {
      if (page.isClosed()) continue;
      const chatId = normalizeUuid(page.url());
      if (!chatId || seen.has(chatId)) continue;
      seen.add(chatId);
      result.push({ runtime, page, chatId });
    }
  }
  return result;
}

function setVirtualFocus(focus: VirtualFocus, runtime: BrowserRuntime, page: Page, source: "manual" | "ctl") {
  runtime.activePage = page;
  runtime.lastFocusAt = Date.now();
  focus.runtime = runtime;
  focus.page = page;
  focus.at = runtime.lastFocusAt;
  focus.pageFocusAt.set(page, focus.at);
  focus.source = source;
  focus.onChange?.("virtual-focus");
}

function getVirtualFocus(focus: VirtualFocus, runtimes: BrowserRuntime[]): { runtime: BrowserRuntime; page: Page } {
  // Keep a CLI-created blank / page-with-first-prompt as focus, but a manually
  // focused non-conversation page must not steal focus away from the last chat.
  if (focus.runtime && focus.page && !focus.page.isClosed() &&
      (Boolean(normalizeUuid(focus.page.url())) || focus.source === "ctl")) {
    return { runtime: focus.runtime, page: focus.page };
  }
  const openChats = openConversationPages(runtimes)
    .sort((a, b) =>
      (focus.pageFocusAt.get(b.page) ?? 0) - (focus.pageFocusAt.get(a.page) ?? 0) ||
      Number(b.page === b.runtime.activePage) - Number(a.page === a.runtime.activePage)
    );
  const latestChat = openChats[0];
  const fallback = latestChat
    ? { runtime: latestChat.runtime, page: latestChat.page }
    : (() => {
        const runtime = runtimes.find((item) => item.name === "default") ?? runtimes[0]!;
        const page = runtime.activePage && !runtime.activePage.isClosed()
          ? runtime.activePage
          : runtime.context.pages().find((candidate) => !candidate.isClosed());
        return page ? { runtime, page } : undefined;
      })();
  if (!fallback) throw new Error("no browser page is available; start the watcher again");
  setVirtualFocus(focus, fallback.runtime, fallback.page, latestChat ? "manual" : "ctl");
  return fallback;
}

async function runtimeForChat(
  sql: Sql,
  runtimes: BrowserRuntime[],
  chatId: string
): Promise<BrowserRuntime> {
  const opened = openConversationPages(runtimes).find((item) => item.chatId === chatId);
  if (opened) return opened.runtime;
  const browserName = await browserNameForChat(sql, chatId);
  return runtimes.find((runtime) => runtime.name === browserName)
    ?? runtimes.find((runtime) => runtime.name === "default")
    ?? runtimes[0]!;
}

async function installFocusTracking(runtime: BrowserRuntime, focus: VirtualFocus) {
  await runtime.context.exposeBinding("__chatgptCtlPageFocused", (source) => {
    if (!source.page.isClosed() && normalizeUuid(source.page.url())) {
      setVirtualFocus(focus, runtime, source.page, "manual");
    }
  });
  const installListeners = () => {
    const notify = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const callback = (window as any).__chatgptCtlPageFocused;
      if (typeof callback === "function") void callback();
    };
    window.addEventListener("focus", notify);
    document.addEventListener("visibilitychange", notify);
    window.addEventListener("pageshow", notify);
  };
  await runtime.context.addInitScript(installListeners);

  const attachPage = (page: Page) => {
    void page.evaluate(installListeners).catch(() => undefined);
    const markWhenActuallyFocused = async () => {
      const focused = await page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()).catch(() => false);
      if (focused && !page.isClosed() && normalizeUuid(page.url())) {
        setVirtualFocus(focus, runtime, page, "manual");
      }
    };
    page.on("domcontentloaded", () => {
      void markWhenActuallyFocused();
      focus.onChange?.("domcontentloaded");
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        void markWhenActuallyFocused();
        focus.onChange?.("main-frame-navigation");
      }
    });
    page.on("close", () => {
      if (focus.page === page) {
        focus.page = undefined;
        focus.runtime = undefined;
      }
      focus.onChange?.("page-close");
    });
  };

  runtime.context.on("page", (page) => {
    attachPage(page);
    focus.onChange?.("page-created");
  });
  for (const page of runtime.context.pages()) {
    attachPage(page);
    const focused = await page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()).catch(() => false);
    if (focused && normalizeUuid(page.url())) setVirtualFocus(focus, runtime, page, "manual");
  }
}

function startControlServer(
  runtimes: BrowserRuntime[],
  focus: VirtualFocus,
  cfg: Config,
  configPath: string,
  sql: Sql
) {
  const defaultRuntime = runtimes.find((runtime) => runtime.name === "default") ?? runtimes[0]!;
  const makePage = async (runtime: BrowserRuntime): Promise<Page> => {
    const page = await runtime.context.newPage();
    configurePage(page, cfg);
    attachNetworkDebug(page, cfg);
    runtime.activePage = page;
    return page;
  };
  const server = Bun.serve({
    hostname: CONTROL_HOST,
    port: CONTROL_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      const opened = openConversationPages(runtimes);
      if (request.method === "GET" && url.pathname === "/status") {
        let active: { runtime: BrowserRuntime; page: Page } | undefined;
        try { active = getVirtualFocus(focus, runtimes); } catch { /* no live page */ }
        return Response.json({
          chat_id: active ? normalizeUuid(active.page.url()) : null,
          browser_name: active?.runtime.name ?? null,
          chat_ids: opened.map((item) => item.chatId),
          panes: opened.map((item, index) => ({ chat_id: item.chatId, browser_name: item.runtime.name, pane_index: index })),
          url: active?.page.url() ?? null,
        });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const body = await request.json().catch(() => ({})) as {
          chat_id?: string; chat?: string; directory?: string; extract_to?: string;
          text?: string; files?: string[]; new_chat?: boolean; draft?: boolean;
        };
        if (url.pathname === "/sync-chats") {
          const counts: Array<{ browser_name: string; count: number }> = [];
          for (const runtime of runtimes) {
            let page = runtime.activePage;
            if (!page || page.isClosed()) page = await getPage(runtime.context);
            runtime.activePage = page;
            await ensureCurrentChatGPTPage(page, cfg);
            const chats = await syncSidebarChats(page, sql, true, runtime.name);
            counts.push({ browser_name: runtime.name, count: chats.length });
          }
          return Response.json({ ok: true, browsers: counts, total: counts.reduce((sum, item) => sum + item.count, 0) });
        }
        if (url.pathname === "/open") {
          const openStartedAt = performance.now();
          const chatId = normalizeUuid(body.chat_id || "");
          if (!chatId) return Response.json({ error: "invalid chat_id" }, { status: 400 });
          const existing = openConversationPages(runtimes).find((item) => item.chatId === chatId);
          const runtime = existing?.runtime ?? await runtimeForChat(sql, runtimes, chatId);
          const alreadyOpen = Boolean(existing);
          const page = existing?.page ?? await makePage(runtime);
          if (!alreadyOpen) {
            const target = new URL(`/c/${chatId}`, cfg.chatgpt.url).toString();
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
            await waitForConversationReady(page, chatId, cfg.browser?.navigation_timeout_ms ?? 45_000);
            await recordChatBrowser(sql, chatId, runtime.name);
          }
          // An already loaded pane is already past the expensive readiness gate.
          // Do not rescrape its entire message history just to focus it again.
          setVirtualFocus(focus, runtime, page, "ctl");
          await page.bringToFront();
          const paneIndex = openConversationPages(runtimes).findIndex((item) => item.chatId === chatId);
          const durationMs = Math.round(performance.now() - openStartedAt);
          log.info(`[ctl] open chat=${chatId} browser=${runtime.name} already_open=${alreadyOpen} duration=${durationMs}ms`);
          return Response.json({ ok: true, chat_id: chatId, browser_name: runtime.name, url: page.url(), already_open: alreadyOpen, pane_index: paneIndex, duration_ms: durationMs });
        }
        if (url.pathname === "/close") {
          const selector = (body.chat || body.chat_id || "").trim();
          if (!selector) return Response.json({ error: "close requires a chat UUID, title, or 0-based pane index" }, { status: 400 });
          const panes = openConversationPages(runtimes);
          let target = panes.find((item) => item.chatId === normalizeUuid(selector));
          if (!target && /^[0-9a-f-]{4,}$/i.test(selector)) {
            const prefix = selector.toLowerCase();
            const prefixMatches = panes.filter((item) => item.chatId.startsWith(prefix));
            if (prefixMatches.length === 1) target = prefixMatches[0];
            else if (prefixMatches.length > 1) {
              return Response.json({ error: `id prefix matches multiple opened chats: ${prefixMatches.map((item) => `${item.runtime.name}:${item.chatId}`).join(", ")}` }, { status: 409 });
            }
          }
          if (!target && /^\d+$/.test(selector)) target = panes[Number(selector)];
          if (!target) {
            const matches = await sql`
              SELECT c.id FROM chats c WHERE c.title ILIKE ${`%${selector}%`}
              ORDER BY c.updated_at DESC NULLS LAST LIMIT 20
            `;
            const ids = new Set(matches.map((row: any) => String(row.id).toLowerCase()));
            const matchingPanes = panes.filter((item) => ids.has(item.chatId));
            if (matchingPanes.length > 1) {
              return Response.json({ error: `title matches multiple opened chats: ${matchingPanes.map((item) => `${item.runtime.name}:${item.chatId}`).join(", ")}` }, { status: 409 });
            }
            target = matchingPanes[0];
          }
          if (!target) return Response.json({ error: `no opened chat matches '${selector}'` }, { status: 404 });
          const closedId = target.chatId;
          const wasFocused = target.page === focus.page;
          await target.page.close();
          if (wasFocused || !focus.page || focus.page.isClosed()) {
            const remaining = openConversationPages(runtimes);
            const next = remaining[remaining.length - 1];
            if (next) {
              setVirtualFocus(focus, next.runtime, next.page, "ctl");
              await next.page.bringToFront();
            } else {
              const page = await makePage(defaultRuntime);
              await openChatGPT(page, cfg);
              setVirtualFocus(focus, defaultRuntime, page, "ctl");
            }
          }
          return Response.json({ ok: true, closed_chat_id: closedId, browser_name: target.runtime.name, chat_ids: openConversationPages(runtimes).map((item) => item.chatId) });
        }
        if (url.pathname === "/new-chat") {
          const runtime = focus.runtime && runtimes.includes(focus.runtime) ? focus.runtime : defaultRuntime;
          const page = await makePage(runtime);
          const target = new URL("/", cfg.chatgpt.url).toString();
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
          await page.locator('#prompt-textarea, [data-composer-markdown][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea').first()
            .waitFor({ state: "visible", timeout: 30_000 });
          const finalUrl = page.url();
          if (normalizeUuid(finalUrl)) {
            await page.close();
            return Response.json({ error: `ChatGPT redirected away from the new-chat URL: ${finalUrl}`, url: finalUrl }, { status: 409 });
          }
          setVirtualFocus(focus, runtime, page, "ctl");
          await page.bringToFront();
          return Response.json({ ok: true, browser_name: runtime.name, url: finalUrl });
        }
        if (url.pathname === "/send") {
          const text = body.text || "";
          const files = Array.isArray(body.files) ? body.files.map((file) => path.resolve(file)) : [];
          const draft = Boolean(body.draft);
          if (!text.trim() && files.length === 0) return Response.json({ error: "text or at least one file is required" }, { status: 400 });
          if (draft && body.new_chat) return Response.json({ error: "--draft cannot be combined with --new-chat; open a blank chat first" }, { status: 400 });
          for (const file of files) await access(file, constants.R_OK);
          const requestedChatId = normalizeUuid(body.chat_id || "");
          let runtime: BrowserRuntime;
          let page: Page;
          if (requestedChatId) {
            runtime = await runtimeForChat(sql, runtimes, requestedChatId);
            const existingPane = openConversationPages([runtime]).find((item) => item.chatId === requestedChatId);
            page = existingPane?.page ?? await makePage(runtime);
            if (!existingPane) {
              const target = new URL(`/c/${requestedChatId}`, cfg.chatgpt.url).toString();
              if (normalizeUuid(page.url()) !== requestedChatId) {
                await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
              }
              await waitForConversationReady(page, requestedChatId, cfg.browser?.navigation_timeout_ms ?? 45_000);
            }
            await recordChatBrowser(sql, requestedChatId, runtime.name);
          } else {
            const virtual = getVirtualFocus(focus, runtimes);
            runtime = virtual.runtime;
            if (body.new_chat) {
              page = await makePage(runtime);
              await page.goto(new URL("/", cfg.chatgpt.url).toString(), {
                waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000,
              });
              await page.locator('#prompt-textarea, [data-composer-markdown][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea').first()
                .waitFor({ state: "visible", timeout: 30_000 });
            } else {
              page = virtual.page;
              if (page.isClosed()) {
                page = await makePage(runtime);
                await ensureCurrentChatGPTPage(page, cfg);
              }
            }
          }
          await sendInPage(page, text, undefined, files, !draft);
          if (body.new_chat) {
            await page.waitForFunction(() =>
              /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(location.pathname),
              null,
              { timeout: 45_000 },
            );
          }
          setVirtualFocus(focus, runtime, page, "ctl");
          await page.bringToFront();
          const acquiredChatId = normalizeUuid(page.url());
          if (body.new_chat && !acquiredChatId) {
            return Response.json({ error: "message was sent but ChatGPT did not expose a conversation UUID yet", url: page.url() }, { status: 504 });
          }
          if (acquiredChatId && (body.new_chat || requestedChatId)) {
            await recordChatBrowser(sql, acquiredChatId, runtime.name);
            await page.waitForTimeout(300);
            const firstSnapshot = await scrapeCurrentChat(page).catch(() => null);
            if (firstSnapshot?.id === acquiredChatId && body.new_chat) {
              await upsertChat(sql, firstSnapshot, runtime.name);
              for (const message of firstSnapshot.messages) await upsertMessage(sql, acquiredChatId, message);
            }
          }
          return Response.json({ ok: true, chat_id: acquiredChatId, browser_name: runtime.name, url: page.url(), new_chat: Boolean(body.new_chat), draft, submitted: !draft });
        }

        const requestedChatId = normalizeUuid(body.chat_id || "");
        // Resolve virtual focus once per request; this preserves the exact page
        // selected across browser profiles and avoids a second fallback decision.
        let virtualTarget: ReturnType<typeof getVirtualFocus> | undefined;
        if (!requestedChatId) {
          try {
            virtualTarget = getVirtualFocus(focus, runtimes);
          } catch (error) {
            if (url.pathname === "/hook/run") return Response.json({
              error: "no virtual-focus conversation is available; open a chat first"
            }, { status: 409 });
            throw error;
          }
        }
        const runtime = requestedChatId ? await runtimeForChat(sql, runtimes, requestedChatId) : virtualTarget!.runtime;
        let page = requestedChatId
          ? openConversationPages([runtime]).find((item) => item.chatId === requestedChatId)?.page
          : virtualTarget!.page;
        if ((url.pathname === "/hook/run" || url.pathname === "/download-last-zip") && requestedChatId && !page) {
          page = await makePage(runtime);
          const target = new URL(`/c/${requestedChatId}`, cfg.chatgpt.url).toString();
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
          await waitForConversationReady(page, requestedChatId, cfg.browser?.navigation_timeout_ms ?? 45_000);
          await recordChatBrowser(sql, requestedChatId, runtime.name);
        }
        if (!page) return Response.json({ error: requestedChatId
          ? `chat ${requestedChatId} is not open in a watcher pane`
          : "no virtual-focus browser page is available; open a conversation first" }, { status: 404 });
        if (url.pathname === "/hook/run") {
          // With no chat_id, run against the conversation currently selected by
          // cross-browser virtual focus. A blank/new-chat page is not a valid target.
          const chatId = requestedChatId || normalizeUuid(page.url());
          if (!chatId) return Response.json({
            error: "virtual focus is not on a conversation; use `chatgpt-ctl open <chat>` or `chatgpt-ctl hook run <chat>` first"
          }, { status: 409 });
          const hook = await loadChatHook(sql, chatId);
          if (!hook) return Response.json({ error: `no hook configured for ${chatId}` }, { status: 404 });
          const archive = await runHookWithLastZip(page, chatId, hook, cfg, configPath);
          setVirtualFocus(focus, runtime, page, "ctl");
          return Response.json({ ok: true, chat_id: chatId, browser_name: runtime.name, archive, url: page.url() });
        }
        if (url.pathname === "/download-last-zip") {
          if (requestedChatId) {
            setVirtualFocus(focus, runtime, page, "ctl");
            await page.bringToFront();
          }
          const directory = body.directory
            ? path.resolve(body.directory)
            : resolveFromConfig(configPath, cfg.downloads?.directory || "./var/downloads");
          const currentChatId = requestedChatId || normalizeUuid(page.url()) || undefined;
          const assistantMessage = await latestAssistantMessage(page, currentChatId);
          const saved = await downloadLastZip(page, directory, assistantMessage);
          if (body.extract_to) {
            const extractTo = path.resolve(body.extract_to);
            const listing = await commandOutput(["unzip", "-Z1", saved]);
            if (listing.code !== 0) throw new Error(`cannot list downloaded ZIP entries: ${listing.stderr}`);
            const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
            for (const entry of entries) {
              const normalized = entry.replace(/\\/g, "/");
              if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === "..")) {
                throw new Error(`unsafe ZIP entry path: ${entry}`);
              }
            }
            await mkdir(extractTo, { recursive: true });
            const topLevel = new Set(entries.map((entry) => entry.replace(/\\/g, "/").split("/")[0]).filter(Boolean));
            const singleRoot = topLevel.size === 1 ? [...topLevel][0]! : null;
            const flattenRoot = Boolean(singleRoot && entries.some((entry) => entry.replace(/\\/g, "/").startsWith(`${singleRoot}/`)));
            if (flattenRoot && singleRoot) {
              const staging = await mkdtemp(path.join(extractTo, ".chatgpt-ctl-unzip-"));
              try {
                const extracted = await commandOutput(["unzip", "-o", "-q", saved, "-d", staging]);
                if (extracted.code !== 0) throw new Error(`ZIP extraction failed: ${extracted.stderr}`);
                const rootDir = path.join(staging, singleRoot);
                await mergeDirectoryContents(rootDir, extractTo);
                log.info(`[download] flattened and merged single root folder '${singleRoot}' from ${saved} into ${extractTo}`);
              } finally {
                await rm(staging, { recursive: true, force: true });
              }
            } else {
              const extracted = await commandOutput(["unzip", "-o", "-q", saved, "-d", extractTo]);
              if (extracted.code !== 0) throw new Error(`ZIP extraction failed: ${extracted.stderr}`);
            }
            log.info(`[download] extracted ${saved} to ${extractTo}`);
            return Response.json({ ok: true, path: saved, browser_name: runtime.name, extracted_to: extractTo, flattened: flattenRoot });
          }
          return Response.json({ ok: true, path: saved, browser_name: runtime.name });
        }
        return new Response("not found", { status: 404 });
      } catch (error) {
        log.error(`[ctl] request failed: ${formatError(error)}`);
        return Response.json({ error: formatError(error) }, { status: 500 });
      }
    },
  });
  log.info(`[ctl] listening on http://${CONTROL_HOST}:${server.port} (${runtimes.length} browser profile(s))`);
  return server;
}

async function watch(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
  await ensureHookSchema(sql);
  await ensureRetrySchema(sql);
  await ensureBrowserSchema(sql);
  const pollMs = Math.max(500, cfg.chatgpt.poll_ms ?? 1500);
  const settleMs = cfg.chatgpt.complete_settle_ms ?? 800;
  const profiles = await discoverBrowserProfiles(cfg, configPath);
  const runtimes: BrowserRuntime[] = [];
  const focus: VirtualFocus = { at: 0, source: "manual", pageFocusAt: new WeakMap<Page, number>() };
  try {
    for (const profile of profiles) {
      await registerBrowser(sql, profile);
      const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false, profile.name);
      runtimes.push({ ...profile, context, lastFocusAt: 0 });
    }
  } catch (error) {
    await Promise.all(runtimes.map((runtime) => runtime.context.close().catch(() => undefined)));
    await sql.end();
    throw error;
  }
  const sessionPersistence = createOpenChatSessionPersistence(sql, runtimes, focus);
  focus.onChange = (reason) => sessionPersistence.schedule(reason);

  const prevIncomplete = new Map<string, number>();
  const lastSeenChatByPage = new WeakMap<Page, string>();
  const readyChatByPage = new WeakMap<Page, string>();
  const baselineAssistantTurnByChat = new Map<string, number | null>();
  const baselineUserTurnByChat = new Map<string, number | null>();
  const baselineUserMessageByChat = new Map<string, string | null>();
  const baselineUserSequenceByChat = new Map<string, number | null>();
  let controlServer: ReturnType<typeof Bun.serve> | undefined;
  const handledHookDownloads = new Set<string>();
  const initializedHookChats = new Set<string>();
  // Newly completed assistant message ids are retained briefly because the
  // downloadable ZIP control can render a poll or two after its message.
  const pendingHookMessages = new Map<string, Map<string, number>>();
  const retryClickCooldowns = new Map<string, number>();
  const deliveryRetryState = new Map<string, { attempts: number; lastAttempt: number; absentPolls: number }>();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info("\n[watch] stopping...");
    controlServer?.stop(true);
    try {
      sessionPersistence.schedule("watch-shutdown");
      const savedCount = await sessionPersistence.flush();
      log.info(`[watch] saved ${savedCount} open chat(s) for the next launch`);
    } catch (error) {
      log.error(`[watch] failed to save open-chat session: ${formatError(error)}`);
    }
    await Promise.all(runtimes.map((runtime) => runtime.context.close().catch(() => undefined)));
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    // Attach focus tracking before navigating restored pages so manually focused
    // tabs continue to update virtual focus across all browser profiles.
    for (const runtime of runtimes) {
      runtime.activePage = await getPage(runtime.context);
      await installFocusTracking(runtime, focus);
      attachNetworkDebug(runtime.activePage, cfg);
    }

    const restoredCount = await restoreOpenChatSession(sql, runtimes, focus, cfg);
    let initialTotal = 0;
    for (const runtime of runtimes) {
      if (!runtime.activePage || runtime.activePage.isClosed()) {
        runtime.activePage = await getPage(runtime.context);
      }
      await ensureCurrentChatGPTPage(runtime.activePage, cfg);
      const sidebarChats = await syncSidebarChats(runtime.activePage, sql, true, runtime.name);
      initialTotal += sidebarChats.length;
      log.info(`[watch] browser=${runtime.name} synchronized ${sidebarChats.length} sidebar chats`);
    }
    const initialFocus = runtimes.find((runtime) => runtime.name === "default") ?? runtimes[0]!;
    if (!focus.page && initialFocus?.activePage) setVirtualFocus(focus, initialFocus, initialFocus.activePage, "manual");
    // Startup restore is complete: commit the authoritative post-restore
    // snapshot now, then keep it current from browser page/focus events.
    sessionPersistence.resume();
    sessionPersistence.schedule("watch-startup");
    await sessionPersistence.flush();
    log.info(`[watch] restored ${restoredCount} previously open chat pane(s)`);
    controlServer = startControlServer(runtimes, focus, cfg, configPath, sql);
    log.info(`[watch] synchronized ${initialTotal} sidebar chats across ${runtimes.length} browser profile(s)`);
    log.info(`[watch] poll=${pollMs}ms settle=${settleMs}ms multi-pane and multi-browser enabled`);

    while (true) {
      try {
        const entries: Array<{ runtime: BrowserRuntime; page: Page }> = [];
        for (const runtime of runtimes) {
          let pages = runtime.context.pages().filter((page) => !page.isClosed());
          if (!runtime.activePage || runtime.activePage.isClosed() || !pages.includes(runtime.activePage)) {
            runtime.activePage = pages[0] ?? await runtime.context.newPage();
            if (pages.length === 0) {
              configurePage(runtime.activePage, cfg);
              attachNetworkDebug(runtime.activePage, cfg);
              await ensureCurrentChatGPTPage(runtime.activePage, cfg);
            }
            pages = runtime.context.pages().filter((page) => !page.isClosed());
          }
          if (pages.length && runtime.activePage) {
            await syncSidebarChats(runtime.activePage, sql, false, runtime.name);
          }
          for (const page of pages) entries.push({ runtime, page });
        }

        await Promise.all(entries.map(async ({ runtime, page }) => {
          try {
            const chat = await scrapeCurrentChat(page);
            if (!chat) return;
            const previousId = lastSeenChatByPage.get(page);
            if (chat.id !== previousId) {
              log.info(`[watch] pane chat=${chat.id} title="${chat.title}"`);
              lastSeenChatByPage.set(page, chat.id);
              sessionPersistence.schedule("poll-observed-route-change");
            }
            if (readyChatByPage.get(page) !== chat.id) {
              // First observation of this route (including in-page navigation):
              // scroll to the actual end and wait for a stable, completed history
              // before persisting or considering any automation.
              const readySnapshot = await waitForConversationReady(
                page, chat.id, cfg.browser?.navigation_timeout_ms ?? 45_000
              );
              await persistChat(sql, readySnapshot, settleMs, prevIncomplete, runtime.name);
              const lastAssistant = [...readySnapshot.messages].reverse().find((message) => message.role === "assistant");
              const lastUser = [...readySnapshot.messages].reverse().find((message) => message.role === "user");
              baselineAssistantTurnByChat.set(chat.id, lastAssistant?.turnOrder ?? null);
              baselineUserTurnByChat.set(chat.id, lastUser?.turnOrder ?? null);
              baselineUserMessageByChat.set(chat.id, lastUser?.id ?? null);
              baselineUserSequenceByChat.set(chat.id, lastUser?.sequence ?? null);
              readyChatByPage.set(page, chat.id);
              lastSeenChatByPage.set(page, chat.id);

              const initialHook = await loadChatHook(sql, chat.id);
              if (initialHook?.enabled) {
                const initialTargets = await findZipTargets(page);
                for (const target of initialTargets) handledHookDownloads.add(`${chat.id}:${target.identity}`);
                initializedHookChats.add(chat.id);
                pendingHookMessages.delete(chat.id);
                log.info(`[hook] ready baseline chat=${chat.id}; ${readySnapshot.messages.length} messages, ${initialTargets.length} ZIP controls; no hook run`);
              } else {
                initializedHookChats.delete(chat.id);
                pendingHookMessages.delete(chat.id);
              }
              return;
            }

            const hook = await loadChatHook(sql, chat.id);
            const hookWasInitialized = initializedHookChats.has(chat.id);
            await recordChatBrowser(sql, chat.id, runtime.name);
            const newAssistantMessages = await persistChat(sql, chat, settleMs, prevIncomplete, runtime.name);

            // Delivery-timeout recovery is automatic, even when the optional
            // generic per-chat Retry setting is off. Bound attempts per failure
            // episode to avoid repeatedly submitting a permanently failing message.
            const deliveryTimedOut = await hasTimedOutDelivery(page, chat.id);
            const deliveryState = deliveryRetryState.get(chat.id);
            if (deliveryTimedOut) {
              const state = deliveryState ?? { attempts: 0, lastAttempt: 0, absentPolls: 0 };
              state.absentPolls = 0;
              const now = Date.now();
              if (state.attempts < 3 && now - state.lastAttempt >= 30_000) {
                state.lastAttempt = now;
                state.attempts += 1;
                try {
                  await retryTimedOutDelivery(page, chat.id);
                } catch (retryError) {
                  log.warn(`[retry] chat=${chat.id} delivery-timeout Retry failed: ${formatError(retryError)}`);
                }
              } else if (state.attempts === 3 && now - state.lastAttempt >= 30_000) {
                // Stop retrying this episode until the timeout alert has cleared.
                state.lastAttempt = now;
                log.warn(`[retry] chat=${chat.id} delivery-timeout retry limit reached (3)`);
              }
              deliveryRetryState.set(chat.id, state);
            } else if (deliveryState) {
              deliveryState.absentPolls += 1;
              if (deliveryState.absentPolls >= 2) deliveryRetryState.delete(chat.id);
            }

            if (!deliveryTimedOut && await isAutoRetryEnabled(sql, chat.id)) {
              const now = Date.now();
              const lastClick = retryClickCooldowns.get(chat.id) ?? 0;
              if (now - lastClick >= 30_000) {
                try {
                  const clicked = await clickRetryAtConversationEnd(page, chat.id);
                  if (clicked) retryClickCooldowns.set(chat.id, now);
                  else retryClickCooldowns.delete(chat.id);
                } catch (retryError) {
                  retryClickCooldowns.set(chat.id, now);
                  log.warn(`[retry] chat=${chat.id} click failed: ${formatError(retryError)}`);
                }
              }
            } else {
              retryClickCooldowns.delete(chat.id);
            }

            if (hook && hook.enabled) {
              const targets = await findZipTargets(page);
              if (!hookWasInitialized) {
                // Opening/navigating to an existing chat is not a hook event.
                // Establish a baseline before accepting any new message IDs.
                for (const target of targets) handledHookDownloads.add(`${chat.id}:${target.identity}`);
                initializedHookChats.add(chat.id);
                pendingHookMessages.delete(chat.id);
                log.info(`[hook] initialized ZIP baseline for chat=${chat.id} (${targets.length} existing attachments; no hook run)`);
              } else {
                const now = Date.now();
                let pending = pendingHookMessages.get(chat.id);
                if (!pending) { pending = new Map<string, number>(); pendingHookMessages.set(chat.id, pending); }
                for (const messageId of newAssistantMessages) pending.set(messageId, now + 5 * 60_000);
                for (const [messageId, expiresAt] of pending) if (expiresAt < now) pending.delete(messageId);
                const latestAssistant = latestAssistantFromMessages(chat.messages);
                const latestUser = [...chat.messages].reverse().find((message) => message.role === "user");
                const baselineTurn = baselineAssistantTurnByChat.get(chat.id);
                const baselineUserTurn = baselineUserTurnByChat.get(chat.id);
                const baselineUserMessage = baselineUserMessageByChat.get(chat.id);
                // A new assistant node alone is insufficient: editing/regenerating
                // an older turn can create a fresh message id. Require a genuinely
                // new user turn beyond the settled history baseline as well.
                const hasNewUserTurn = Boolean(latestUser && latestUser.id !== baselineUserMessage &&
                  latestUser.turnOrder !== undefined && baselineUserTurn !== null &&
                  baselineUserTurn !== undefined && latestUser.turnOrder > baselineUserTurn);
                // Resolve the latest completed assistant once per polling cycle.
                // Candidate selection, concurrent ZIP probes, and durable history
                // are shared with the manual ctl hook path.
                if (hasNewUserTurn && latestAssistant && pending.has(latestAssistant.id) &&
                    baselineTurn !== null && baselineTurn !== undefined &&
                    latestAssistant.turnOrder !== undefined && latestAssistant.turnOrder > baselineTurn) {
                  const associated = targets.filter((target) =>
                    zipTargetAssociation(target, latestAssistant) !== null &&
                    target.messageOrder === latestAssistant.turnOrder);
                  const hookKey = `${chat.id}:${latestAssistant.id}`;
                  if (associated.length && !handledHookDownloads.has(hookKey)) {
                    try {
                      const archiveDir = path.resolve(resolveFromConfig(configPath, hook.folder), ".chatgpt-ctl-downloads");
                      const archive = await downloadLastZip(page, archiveDir, latestAssistant);
                      handledHookDownloads.add(hookKey);
                      pending.delete(latestAssistant.id);
                      await runHookForZip(page, chat.id, hook, archive, configPath);
                    } catch (hookError) {
                      log.error(`[hook] chat=${chat.id} failed: ${formatError(hookError)}`);
                    }
                  }
                }
              }
            } else {
              initializedHookChats.delete(chat.id);
              pendingHookMessages.delete(chat.id);
            }
          } catch (pageError) {
            log.error(`[watch] pane scan failed url=${page.url()}: ${formatError(pageError)}`);
          }
        }));
      } catch (error) {
        log.error(`[watch] scan failed:\n${formatError(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    log.error(`[watch] fatal:\n${formatError(error)}`);
    controlServer?.stop(true);
    try {
      sessionPersistence.schedule("fatal-shutdown");
      const savedCount = await sessionPersistence.flush();
      log.info(`[watch] saved ${savedCount} open chat(s) after fatal watcher error`);
    } catch (saveError) {
      log.error(`[watch] failed to save open-chat session: ${formatError(saveError)}`);
    }
    await Promise.all(runtimes.map((runtime) => runtime.context.close().catch(() => undefined)));
    await sql.end();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "doctor";
  const configPath = path.resolve(
    args.find((a, i) => args[i - 1] === "--config") ||
      process.env.CHATGPT_WATCHER_CONFIG ||
      path.join(import.meta.dir, "../config.toml")
  );

  const cfg = await loadConfig(configPath);

  switch (command) {
    case "doctor":
      return doctor(cfg, configPath);
    case "sync-chats":
      return syncChatsCommand(cfg, configPath, args.includes("--quiet"));
    case "open": {
      const id = args[1];
      if (!id) throw new Error("Usage: open <chat-uuid>");
      return openChatCommand(cfg, configPath, id);
    }
    case "download-last-zip": {
      const directory = args[1] ? path.resolve(args[1]) : path.resolve(cfg.downloads?.directory || "./var/downloads");
      const response = await fetch(`http://${CONTROL_HOST}:${CONTROL_PORT}/download-last-zip`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; path?: string };
      if (!response.ok) throw new Error(result.error || `watch control server returned ${response.status}`);
      console.log(result.path);
      return;
    }
    case "send": {
      const files: string[] = [];
      const textParts: string[] = [];
      let draft = false;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--config") {
          i++;
        } else if (arg === "--draft" || arg === "--no-send") {
          draft = true;
        } else if (arg === "--file" || arg === "-f") {
          const file = args[++i];
          if (!file) throw new Error(`send: ${arg} requires a path`);
          files.push(file);
        } else if (arg.startsWith("--file=")) {
          files.push(arg.slice("--file=".length));
        } else {
          textParts.push(arg);
        }
      }
      return sendMessageCommand(cfg, configPath, textParts.join(" "), files, draft);
    }
    case "login": {
      const nameArg = args.find((arg) => arg.startsWith("--browser-name="));
      const nameIndex = args.findIndex((arg) => arg === "--browser-name");
      const browserName = nameArg
        ? nameArg.slice("--browser-name=".length)
        : nameIndex >= 0 ? args[nameIndex + 1] : "default";
      if ((nameIndex >= 0 && !browserName) || browserName === "") {
        throw new Error("login: --browser-name requires a name");
      }
      return login(cfg, configPath, browserName || "default");
    }
    case "migrate":
      return migrate(cfg);
    case "flush":
      return flush(cfg);
    case "dump":
      return dump(cfg, configPath);
    case "once":
      return once(cfg, configPath);
    case "watch":
      return watch(cfg, configPath);
    default:
      throw new Error(
        `Unknown command '${command}'. Use doctor | login | sync-chats | open | new-chat | download-last-zip | send | migrate | flush | dump | once | watch`
      );
  }
}

main().catch((error) => {
  log.error(formatError(error));
  process.exit(1);
});

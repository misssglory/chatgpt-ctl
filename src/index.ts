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
import { access, constants, lstat, mkdir, mkdtemp, readdir, rename, rm, readFile, writeFile, open, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { zipTargetsAfterCursor, zipTargetIsAfterCursor } from "./zip-cursor.mjs";
import { autoZipCandidates } from "./auto-zip-candidates.mjs";
import { nextZipAutoRetry, pendingZipCandidates } from "./auto-zip-retry.mjs";
import { freshZipCandidates } from "./fresh-zip-candidates.mjs";
import { conversationLengthLimitPattern } from "./conversation-length-limit.mjs";

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
  snapshots?: { hotkey?: string; directory?: string };
  hooks?: { default_build_command?: string; failure_report_max_chars?: number };
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
  /** Startup navigation/focus events must not override the saved virtual focus. */
  restoring?: boolean;
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
  timeoutMs?: number,
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
  // External clipboard commands may wait indefinitely for a Wayland owner.
  // Fail within a small budget so build-error reporting cannot block the UI.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, timeoutMs);
  }
  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    code = await proc.exited;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

type HookStage = { type: "build" | "git-add" | "git-commit" | "custom"; command?: string };

type ChatHook = {
  folder: string;
  child_folder: string;
  nix_flake: boolean;
  clipboard_command: string[];
  build_command: string | null;
  stages: HookStage[];
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
  await sql.unsafe(`ALTER TABLE chatgpt_watcher_browsers ADD COLUMN IF NOT EXISTS auto_open boolean NOT NULL DEFAULT true`);
  await sql.unsafe(`ALTER TABLE chatgpt_watcher_browsers ADD COLUMN IF NOT EXISTS default_project text`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS chatgpt_watcher_project_scans (
    browser_name text NOT NULL,
    project_id text NOT NULL,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    project_order integer NOT NULL,
    scanned_at timestamptz,
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (browser_name, project_id, chat_id)
  )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS watcher_project_scans_pending
    ON chatgpt_watcher_project_scans (browser_name, project_id, project_order) WHERE scanned_at IS NULL`);

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
  // Store the virtual-focus identity explicitly. Timestamp ordering is useful
  // for fallback, but isn't authoritative when pages are opened during startup.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chatgpt_watcher_virtual_focus (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      browser_name text NOT NULL,
      chat_id uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function registerBrowser(sql: Sql, profile: BrowserProfile): Promise<void> {
  await sql`
    INSERT INTO chatgpt_watcher_browsers (name, profile_dir, updated_at)
    VALUES (${profile.name}, ${profile.profileDir}, NOW())
    ON CONFLICT (name) DO UPDATE SET profile_dir=EXCLUDED.profile_dir, updated_at=NOW()
  `;
}

async function browserStartupEnabled(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql`SELECT auto_open FROM chatgpt_watcher_browsers WHERE name = ${name}`;
  return rows.length === 0 || rows[0]!.auto_open !== false;
}

async function setBrowserStartupEnabled(sql: Sql, name: string, enabled: boolean): Promise<void> {
  await sql`UPDATE chatgpt_watcher_browsers SET auto_open = ${enabled}, updated_at = NOW() WHERE name = ${name}`;
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
  const savedKeys = new Set<string>();
  for (const runtime of runtimes) {
    let paneOrder = 0;
    for (const page of runtime.context.pages()) {
      if (page.isClosed()) continue;
      const chatId = normalizeUuid(page.url());
      if (!chatId) continue; // Ignore blank tabs, ChatGPT home, and transient new chats.
      const key = `${runtime.name}:${chatId}`;
      if (savedKeys.has(key)) {
        // A hook/download race or external browser navigation can produce two
        // tabs displaying the same chat. The DB key is (browser_name,chat_id).
        // Never let duplicate pages invalidate the complete session snapshot.
        continue;
      }
      savedKeys.add(key);
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

  const focusedChatId = focus.page && !focus.page.isClosed()
    ? normalizeUuid(focus.page.url()) : null;
  const focusedBrowser = focusedChatId && focus.runtime ? focus.runtime.name : null;
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
        ON CONFLICT (browser_name, chat_id) DO UPDATE
          SET pane_order = EXCLUDED.pane_order,
              focused_at = EXCLUDED.focused_at,
              updated_at = NOW()
      `;
    }
    if (focusedBrowser && focusedChatId && snapshot.some((item) =>
      item.browser_name === focusedBrowser && item.chat_id === focusedChatId)) {
      await tx`
        INSERT INTO chatgpt_watcher_virtual_focus (singleton, browser_name, chat_id, updated_at)
        VALUES (true, ${focusedBrowser}, ${focusedChatId}::uuid, NOW())
        ON CONFLICT (singleton) DO UPDATE
          SET browser_name=EXCLUDED.browser_name, chat_id=EXCLUDED.chat_id, updated_at=NOW()
      `;
    } else if (snapshot.length === 0) {
      await tx`DELETE FROM chatgpt_watcher_virtual_focus WHERE singleton = true`;
    } else {
      // The focused pane was closed. The next startup should choose the best
      // remaining focus candidate rather than follow a stale explicit target.
      await tx`DELETE FROM chatgpt_watcher_virtual_focus WHERE singleton = true`;
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
  const explicitRows = await sql`
    SELECT browser_name, chat_id::text AS chat_id
    FROM chatgpt_watcher_virtual_focus WHERE singleton = true
  `;
  const explicitFocus = explicitRows.length ? {
    browserName: String(explicitRows[0]!.browser_name),
    chatId: String(explicitRows[0]!.chat_id),
  } : undefined;

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
  const lastFocused = (explicitFocus && focusCandidates.find((candidate) =>
    candidate.runtime.name === explicitFocus.browserName &&
    normalizeUuid(candidate.page.url()) === explicitFocus.chatId
  )) ?? focusCandidates.sort((a, b) => b.focusedAt - a.focusedAt)[0];
  if (lastFocused) {
    setVirtualFocus(focus, lastFocused.runtime, lastFocused.page, "ctl");
    log.info(`[watch] restored virtual focus chat=${normalizeUuid(lastFocused.page.url())} browser=${lastFocused.runtime.name} source=${explicitFocus && normalizeUuid(lastFocused.page.url()) === explicitFocus.chatId && lastFocused.runtime.name === explicitFocus.browserName ? "saved-target" : "timestamp-fallback"}`);
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
      stages jsonb,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Keep existing installations compatible; this is a non-destructive additive migration.
  await sql.unsafe("ALTER TABLE chat_hooks ADD COLUMN IF NOT EXISTS build_command text DEFAULT 'wcc build'");
  await sql.unsafe("ALTER TABLE chat_hooks ADD COLUMN IF NOT EXISTS stages jsonb");
}

function parseHookStages(raw: unknown, buildCommand: string | null): HookStage[] {
  const decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
  // NULL means a pre-pipeline hook: migrate its behavior to build + git-add.
  if (decoded == null) return [
    ...(buildCommand && buildCommand.trim() ? [{ type: "build" as const }] : []),
    { type: "git-add" },
  ];
  if (!Array.isArray(decoded)) throw new Error("hook stages must be a JSON array");
  return decoded.map((step, index) => {
    if (!step || typeof step !== "object" ||
      !["build", "git-add", "git-commit", "custom"].includes(step.type) ||
      (step.type === "custom" && (typeof step.command !== "string" || !step.command.trim()))) {
      throw new Error(`invalid hook stage at index ${index}`);
    }
    return { type: step.type, ...(step.type === "custom" ? { command: step.command } : {}) } as HookStage;
  });
}

async function loadChatHook(sql: Sql, chatId: string): Promise<ChatHook | null> {
  const rows = await sql`
    SELECT folder, child_folder, nix_flake, clipboard_command, enabled, build_command, stages
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
    stages: parseHookStages(row.stages, row.build_command),
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
async function upsertMessage(sql: Sql, chatId: string, msg: ScrapedMessage, reindexSequence = false): Promise<"inserted" | "updated" | "completed"> {
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
      sequence = CASE WHEN ${reindexSequence} THEN EXCLUDED.sequence ELSE messages.sequence END,
      completed = messages.completed OR EXCLUDED.completed,
      completed_at = CASE
        WHEN messages.completed = false AND EXCLUDED.completed = true THEN statement_timestamp()
        ELSE messages.completed_at
      END
    -- Avoid touching the same completed history rows on every poll. This also
    -- prevents needless WAL/index churn for long conversations.
    WHERE messages.content IS DISTINCT FROM EXCLUDED.content
       OR (${reindexSequence} AND messages.sequence IS DISTINCT FROM EXCLUDED.sequence)
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

/**
 * Detect *active* browser-verification UI, not incidental mentions of CAPTCHA in
 * a conversation or Cloudflare's ubiquitous background JS detector.
 * Captcha iframes may live in shadow DOM; inspect live iframe URLs as well.
 */
async function activeBrowserChallenge(page: Page): Promise<string | null> {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate(() => {
      const pathname = location.pathname.toLowerCase();
      if (/\/cdn-cgi\/challenge-platform\//.test(pathname) || /\/challenge\/?$/.test(pathname)) {
        return `verification route: ${pathname}`;
      }
      const title = document.title.trim();
      if (/^(?:just a moment|attention required|security check|verify you are human|human verification)(?:[.!… ]*)$/i.test(title)) {
        return `verification title: ${title}`;
      }
      const isVisible = (element: Element) => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      // Only inspect visible challenge *containers*: normal message content
      // must not trigger browser shutdown just because it discusses CAPTCHAs.
      for (const selector of [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="recaptcha/api2/"]',
        'iframe[src*="hcaptcha.com/captcha"]',
        '.cf-turnstile', '#cf-challenge-running', '#challenge-stage',
        '#challenge-form', '[data-testid="captcha-challenge"]',
      ]) {
        for (const element of document.querySelectorAll(selector)) {
          if (isVisible(element)) return `visible verification control: ${selector}`;
        }
      }
      const challengeContainer = document.querySelector('#challenge-stage, #challenge-form, .cf-browser-verification');
      if (challengeContainer && isVisible(challengeContainer) &&
          /(?:verify you are human|checking your browser|verify that you are human|security check|unusual traffic)/i.test(challengeContainer.textContent ?? "")) {
        return 'visible browser verification challenge';
      }
      return null;
    });
  } catch {
    // Navigation or manual tab closure can race a check. Never assume that
    // a page evaluation error means verification is needed.
    return null;
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
      // ChatGPT renders fenced code as a visual CodeBlock (pre > code), not
      // literal Markdown fences. Persist the exact code and its language in
      // a machine-readable form so the PostgreSQL/Ratatui code tab can find it.
      // Exclude non-code "pre" decorations and do not serialize toolbar text.
      const blocks: string[] = [];
      // Two currently observed ChatGPT layouts:
      //   Rust/Bash: <pre><code>...</code></pre>
      //   TOML:      <div data-code-block="true">...<code>...</code></div>
      // Index the outer code-block once; do not include inline prose <code> or
      // duplicate the same block through both selectors.
      const codeRoots = Array.from(candidate.querySelectorAll('[data-code-block="true"], [class*="CodeBlock-"]'))
        .filter(root => !root.parentElement?.closest('[data-code-block="true"], [class*="CodeBlock-"]'));
      const processed = new Set<Element>();
      const appendCode = (code: Element, root: Element) => {
        if (processed.has(code)) return;
        const value = (code.textContent || '').replace(/\r\n/g, '\n').trimEnd();
        if (!value.trim()) return;
        const header = root.querySelector('[class*="ActionBar"] [class*="truncate"], [data-code-language]');
        const hint = header?.getAttribute('data-code-language') || header?.textContent ||
          Array.from(code.classList).find(x => x.startsWith('language-'))?.replace(/^language-/, '') || '';
        const language = hint.trim().toLowerCase().replace(/[^a-z0-9+#._-]/g, '').slice(0, 32);
        const longest = Math.max(3, ...Array.from(value.matchAll(/`+/g), m => m[0].length + 1));
        const fence = '`'.repeat(longest);
        blocks.push(`${fence}${language}\n${value}\n${fence}`);
        processed.add(code);
      };
      for (const root of codeRoots) {
        const code = root.querySelector('pre > code, [class*="CodeContent"], .chatgpt-code-scrollport code');
        if (code) appendCode(code, root);
      }
      // Legacy ChatGPT markup has no code-block wrapper, only pre > code.
      for (const code of Array.from(candidate.querySelectorAll('pre > code'))) {
        if (processed.has(code)) continue;
        const pre = code.parentElement;
        const root = pre?.closest('[class*="InlineCodePane"], [class*="CodeBlock"], [data-code-block]')?.parentElement?.parentElement || pre?.parentElement;
        if (root) appendCode(code, root);
      }
      if (blocks.length) content += '\n\n' + blocks.join('\n\n');

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
  await ensureChatFilesSchema(sql);
    for (const profile of profiles) {
      const allowed = await browserStartupEnabled(sql, profile.name);
      await registerBrowser(sql, profile);
      if (!allowed) {
        log.info(`[watch] browser=${profile.name} stays closed (manual close persisted)`);
        continue;
      }
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
async function login(cfg: Config, configPath: string, browserName = "default", initialUrl?: string) {
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
      initialUrl ?? cfg.chatgpt.url,
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
  await ensureChatFilesSchema(sql);
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
      const status = await upsertMessage(sql, chat.id, msg, reindexSequence);
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

async function persistChat(sql: Sql, chat: ScrapedChat, settleMs: number, prevIncomplete: Map<string, number>, browserName = "default", reindexSequence = false): Promise<Set<string>> {
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

    const status = await upsertMessage(sql, chat.id, msg, reindexSequence);
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
  await ensureChatFilesSchema(sql);
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
  const selector = 'a[href], [role="link"], button[aria-label]';
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
      // User uploads are rendered as resource cards; never treat them as hook archives.
      // An assistant generated artifact must be a link, and must belong to a
      // message with a verifiable assistant identity (checked by caller).
      if (!isLink || (!hasZipExtension && !isDescriptiveZipLink && !isGeneratedDownload)) return;
      if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return;

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

/** Any message-owned file: assistant-generated download or user upload. */
type ChatFile = {
  identity: string;
  label: string;
  role: "assistant" | "user";
  messageId: string | null;
  messageOrder: number | null;
  position: number;
  selector: string;
  index: number;
  userExcerpt: string;
};

function fileNameForDownload(raw: string): string {
  const leaf = path.basename(raw.replace(/\\/g, "/"))
    .replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  return leaf && leaf !== "." && leaf !== ".." ? leaf : "chatgpt-file";
}

/** Index assistant download links and user-owned upload cards, never chat navigation. */
async function findChatFiles(page: Page, messages: ScrapedMessage[]): Promise<ChatFile[]> {
  const selector = 'a[href], [role="link"], button[aria-label], button[data-testid*="file"], button[data-testid*="attachment"], [data-testid*="file"][role="button"]';
  const observed = await page.locator(selector).evaluateAll((elements) => elements.map((element, index) => {
    const el = element as HTMLElement;
    const aria = el.getAttribute("aria-label") || "";
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    const title = el.getAttribute("title") || "";
    const download = el.getAttribute("download") || "";
    const testId = el.getAttribute("data-testid") || "";
    const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") || "" : "";
    // Exclude navigation and buttons which merely contain the word 'file'.
    const isDownload = /^Open\s+Download\b/i.test(aria) || Boolean(download) ||
      /(?:^|\s)Download\s+.+/i.test(text) ||
      /\.(?:zip|patch|diff|txt|md|pdf|png|jpe?g|webp|mp4|mov|csv|json|py|rs|ts|js|sh|bash|zsh|fish|nix|yaml|yml|toml|html|css|sql|log|xml|ini|conf|cfg|env|xlsx?|docx?|pptx?)(?:$|[?#\s])/i.test(`${aria} ${title} ${text} ${href}`);
    const isCard = /file|attachment|resource/i.test(testId) ||
      /^(?:Open\s+preview\s+of|Preview|Download|Open\s+(?:file|attachment))\b/i.test(aria);
    if ((!isDownload && !isCard) || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return null;
    const ancestor = el.closest('[data-chatgpt-search-message-ids], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-message-author-role]');
    let messageId = (ancestor?.getAttribute("data-chatgpt-search-message-ids") || "")
      .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
    let messageOrder: number | null = null;
    let node: HTMLElement | null = el;
    while (node) {
      if (!messageId) {
        const raw = node.getAttribute("data-dil-message-id") || node.getAttribute("data-dil-source-message-id") ||
          node.getAttribute("data-chatgpt-selection-message-id") || node.getAttribute("data-chatgpt-search-message-ids") || "";
        messageId = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
      }
      if (messageOrder === null) {
        const key = node.getAttribute("data-content-search-unit-key") || node.getAttribute("data-chatgpt-search-unit-key") || "";
        const found = key.match(/(?:fallback-)?turn[-_](\d+)/i);
        if (found) messageOrder = Number(found[1]);
      }
      node = node.parentElement;
    }
    const label = [download, aria, title, text].find((value) => /\.[A-Za-z\d]{1,10}(?:$|\s)/.test(value)) ||
      [aria, title, text, download].find(Boolean) || href || "file";
    return { index, selector, aria, messageId: messageId.toLowerCase() || null,
      messageOrder, label: label.replace(/^Open\s+Download\s+/i, "").replace(/^Open\s+preview\s+of\s+/i, "").replace(/^Open\s+/i, "").trim().slice(0, 300),
      isCard, isDownload, testId };
  }).filter(Boolean));
  // One attachment can be represented by an inline "Open Download" link AND
  // a resource card with "Open preview" + "Download file" controls. Index the
  // attachment, not its UI controls. Prefer its explicit download link.
  const unique = new Map<string, ChatFile & { priority: number }>();
  for (const entry of observed) {
    if (!entry) continue;
    const owner = messages.find((m) => entry.messageId && m.id.toLowerCase() === entry.messageId) ||
      messages.find((m) => entry.messageOrder !== null && m.turnOrder === entry.messageOrder);
    if (!owner || !["assistant", "user"].includes(owner.role)) continue;
    if (owner.role === "assistant" && !entry.isDownload) continue;
    if (owner.role === "user" && !entry.isCard && !entry.isDownload) continue;
    const role = owner.role as "assistant" | "user";
    const rawLabel = entry.label.replace(/^Preview\s+/i, '').replace(/^Download\s+/i, '').trim();
    // Generic card buttons are not attachment identities; their neighbouring
    // named preview button already represents the actual file.
    if (!rawLabel || /^(?:file|download|preview)$/i.test(rawLabel)) continue;
    const key = `${owner.id.toLowerCase()}|${rawLabel}`;
    const user = messages.filter((m) => m.role === "user" && m.sequence <= owner.sequence).at(-1);
    const priority = /^Open\s+Download\s+/i.test((entry as any).aria || '') ? 4 :
      /^Open\s+preview\s+of\s+/i.test((entry as any).aria || '') ? 2 :
      entry.isDownload ? 3 : 1;
    const next = {
      identity: `${key}|0`, label: rawLabel, role, messageId: owner.id.toLowerCase(),
      messageOrder: entry.messageOrder ?? owner.turnOrder ?? null, position: entry.index,
      selector: entry.selector, index: entry.index,
      userExcerpt: (owner.role === "user" ? owner.content : user?.content || '')
        .replace(/\s+/g, ' ').slice(0, 180), priority,
    };
    const previous = unique.get(key);
    if (!previous || priority > previous.priority) unique.set(key, next);
  }
  const result: ChatFile[] = Array.from(unique.values()).map(({ priority: _priority, ...file }) => file);
  return result;
}

async function ensureChatFilesSchema(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS chatgpt_watcher_files (
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
    UNIQUE(chat_id, identity)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS chatgpt_watcher_files_fresh_idx
    ON chatgpt_watcher_files (discovered_at DESC, id DESC)`;
}

const indexedFileSignatures = new Map<string, string>();
async function indexChatFiles(sql: Sql, page: Page, chat: ScrapedChat): Promise<void> {
  const files = await findChatFiles(page, chat.messages);
  const signature = files.map((file) => `${file.identity}:${file.userExcerpt}`).join("\n");
  if (indexedFileSignatures.get(chat.id) === signature) return;
  for (const file of files) {
    await sql`INSERT INTO chatgpt_watcher_files
       (chat_id, identity, role, label, message_id, message_order, position, user_excerpt)
       VALUES (${chat.id}, ${file.identity}, ${file.role}, ${file.label}, ${file.messageId},
         ${file.messageOrder}, ${file.position}, ${file.userExcerpt})
       ON CONFLICT (chat_id, identity) DO UPDATE SET
         label = EXCLUDED.label, user_excerpt = EXCLUDED.user_excerpt,
         message_order = EXCLUDED.message_order, position = EXCLUDED.position`;
    // Remove stale rows produced by earlier scans of the same attachment's
    // inline link and preview card. Don't delete unseen historical attachments.
    await sql`DELETE FROM chatgpt_watcher_files
      WHERE chat_id = ${chat.id} AND message_id = ${file.messageId}
        AND label = ${file.label} AND identity <> ${file.identity}`;
  }
  indexedFileSignatures.set(chat.id, signature);
}

/** Identify a file preview opened by this request. Never search the entire chat
 * for an unqualified "Download file" button: attachment cards have their own
 * controls and overlays which intercept clicks on unrelated buttons. */
async function openedFilePreviewRoot(viewer: Page, previousDialogs: number, isPopup: boolean, filename?: string) {
  // ChatGPT's newer file viewer opens a *right-hand tab panel*, not a dialog.
  // Match the exact filename to avoid downloading an unrelated open file tab.
  if (filename) {
    const tabs = viewer.locator('[role="tabpanel"][data-tab-id^="chatgpt-file:"]');
    for (const tab of await tabs.all()) {
      if (!(await tab.isVisible().catch(() => false))) continue;
      const name = await tab.getAttribute('aria-label');
      const id = await tab.getAttribute('data-tab-id');
      if (name === filename || id?.endsWith(`:${filename}`)) return tab;
    }
  }
  const selectors = '[role="dialog"], [data-radix-dialog-content], [data-testid*="file-preview"], [data-testid*="preview-panel"]';
  const roots = viewer.locator(selectors).filter({ visible: true });
  const count = await roots.count();
  if (count > previousDialogs) return roots.last();
  // A separate popup is already scoped to the opened file, unlike the chat page.
  return isPopup ? viewer.locator('body') : null;
}

/** Extract displayed text only from a newly opened preview, not the chat itself. */
async function readFilePreview(viewer: Page, previousDialogs: number, isPopup: boolean, filename?: string): Promise<string | null> {
  return viewer.evaluate(({ previousCount, popup, name }) => {
    const visible = (el: HTMLElement) => el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden';
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [data-radix-dialog-content], [data-testid*="file-preview"], [data-testid*="preview-panel"]'
    )).filter(visible);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(
      '[role="tabpanel"][data-tab-id^="chatgpt-file:"]')).filter(visible);
    const matchedTab = name ? tabs.find(el => el.getAttribute('aria-label') === name ||
      (el.getAttribute('data-tab-id') || '').endsWith(`:${name}`)) : null;
    const root = matchedTab || (dialogs.length > previousCount ? dialogs.at(-1) :
      (popup ? document.querySelector<HTMLElement>('main') || document.body : null));
    if (!root) return null;
    // The ZIP viewer advertises an unsupported archive preview. That banner
    // must never be saved as the contents of the requested ZIP file.
    if (matchedTab && /archive previews aren.t supported yet/i.test(root.innerText || '')) return null;
    const content = root.querySelector<HTMLElement>(
      '[data-testid*="file-preview"] pre, [data-testid*="preview-content"], .monaco-editor .view-lines, '
      + '[role="code"], pre code, pre, [data-language], textarea, article'
    );
    const target = content || root;
    const value = target instanceof HTMLTextAreaElement ? target.value :
      (target.innerText || target.textContent || '');
    const cleaned = value.replace(/\r\n/g, '\n').trim();
    // An unavailable ChatGPT file may open a preview shell containing an
    // error. Never save that error banner as if it were file contents.
    if (/^(?:couldn[’']t|cannot|unable to) load (?:this |the )?file\.?$/i.test(cleaned) ||
        /^(?:file (?:not found|unavailable)|failed to load file)\.?$/i.test(cleaned)) return null;
    const controls = Array.from(root.querySelectorAll('button')).map(e =>
      (e.getAttribute('aria-label') || e.textContent || '').trim());
    if (!content && (cleaned.length < 40 || (controls.length && cleaned.length < 100))) return null;
    return cleaned.length ? cleaned + '\n' : null;
  }, { previousCount: previousDialogs, popup: isPopup, name: filename }).catch(() => null);
}

/** Collect downloads across the originating chat and any preview popup. A download
 * can be emitted *after* the click promise resolves or on a popup Page rather
 * than the original conversation Page. Listeners stay active until retrieval
 * finishes; short waitForEvent timeouts previously discarded successful files. */
function watchAttachmentDownloads(page: Page) {
  const context = page.context();
  const downloads: Download[] = [];
  const watched = new Set<Page>();
  let wake: (() => void) | undefined;
  const onDownload = (download: Download) => {
    downloads.push(download);
    wake?.();
    wake = undefined;
  };
  const watch = (p: Page) => {
    if (!watched.has(p)) {
      watched.add(p);
      p.on('download', onDownload);
    }
  };
  for (const p of context.pages()) watch(p);
  context.on('page', watch);
  return {
    async next(timeoutMs: number): Promise<Download | null> {
      if (downloads.length) return downloads.shift()!;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { if (wake === finish) wake = undefined; resolve(); }, timeoutMs);
        const finish = () => { clearTimeout(timer); resolve(); };
        wake = finish;
      });
      return downloads.shift() || null;
    },
    stop() {
      context.off('page', watch);
      for (const p of watched) p.off('download', onDownload);
      wake?.();
      wake = undefined;
    },
  };
}

/** Click an indexed attachment and retrieve the actual download or its text preview. */
/** The top chat/project Files menu renders a separate right-side "Files in chat"
 * tab. It contains named file buttons independent of the virtualized transcript.
 * Never search a generic Download button outside the selected file's preview.
 */
function chatFilesPanel(page: Page) {
  return page.locator('[role="tabpanel"][aria-label="Files in chat"]:visible');
}

async function ensureChatFilesPanel(page: Page): Promise<boolean> {
  if (await chatFilesPanel(page).count()) return true;
  // ChatGPT exposes the menu from its chat header in some builds, and from
  // the chat sidebar options in others. A missing menu is a normal fallback.
  for (const selector of ['button[aria-label="Chat sidebar options"]', 'button[aria-label="Chat actions"]']) {
    const trigger = page.locator(selector).filter({ visible: true }).first();
    if (!(await trigger.count())) continue;
    try {
      await trigger.click({ timeout: 1800 });
      const menu = page.getByRole('menuitem', { name: /^(?:files|files in chat|view files)$/i }).first();
      if (await menu.isVisible().catch(() => false)) {
        await menu.click({ timeout: 1800 });
        if (await chatFilesPanel(page).count()) return true;
      }
      await page.keyboard.press('Escape').catch(() => {});
    } catch { await page.keyboard.press('Escape').catch(() => {}); }
  }
  return (await chatFilesPanel(page).count()) > 0;
}

async function filePanelNames(page: Page): Promise<string[]> {
  if (!(await ensureChatFilesPanel(page))) return [];
  // DOM order in the screenshot is newest first; retain it, including repeated
  // names, rather than guessing recency from lexical filenames.
  return chatFilesPanel(page).locator('ul[aria-label="Files in chat"] > li > button[aria-label]')
    .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || '')
      .filter(Boolean));
}

async function downloadFromChatFilesPanel(page: Page, filename: string, directory: string, zipOnly = false): Promise<string | null> {
  const names = await filePanelNames(page);
  if (!names.includes(filename)) return null;
  const panel = chatFilesPanel(page);
  // When names repeat, the topmost entry is the most recent in the Files menu.
  // Some Playwright versions do not resolve a button nested under a button
  // locator using getByRole. Use a CSS attribute with an escaped string.
  const button = panel.locator('ul[aria-label="Files in chat"] > li > button[aria-label]');
  const index = names.indexOf(filename);
  if (index < 0 || !(await button.nth(index).count())) return null;
  const collector = watchAttachmentDownloads(page);
  let previewOpened = false;
  try {
    log.info(`[files] trying Files-in-chat menu name='${filename}'`);
    await button.nth(index).click({ timeout: 5000 });
    let event = await collector.next(900);
    let preview = await openedFilePreviewRoot(page, 0, false, filename);
    for (let attempt = 0; !event && !preview && attempt < 10; attempt++) {
      await page.waitForTimeout(250);
      preview = await openedFilePreviewRoot(page, 0, false, filename);
    }
    previewOpened = !!preview;
    if (!event && preview) {
      const download = preview.locator('[data-testid="viewer-header"]')
        .getByRole('button', { name: 'Download', exact: true }).first();
      const fallback = preview.getByRole('button', { name: /^download(?: file)?$/i }).first();
      const target = await download.isVisible().catch(() => false) ? download : fallback;
      if (await target.isVisible().catch(() => false)) {
        log.info(`[files] clicking Files-in-chat preview Download name='${filename}'`);
        await target.click({ timeout: 5000 });
        event = await collector.next(12_000);
      }
    }
    if (!event) return null;
    await mkdir(directory, { recursive: true });
    const suggested = fileNameForDownload(event.suggestedFilename() || filename);
    // Avoid surprising cross-file downloads from a stale selected viewer.
    if (suggested.toLowerCase() !== fileNameForDownload(filename).toLowerCase()) {
      log.warn(`[files] menu download filename mismatch selected='${filename}' actual='${suggested}'`);
      return null;
    }
    const dest = path.join(directory, `${crypto.randomUUID().slice(0, 8)}-${suggested}`);
    await event.saveAs(dest);
    const info = await stat(dest);
    if (!info.isFile() || info.size === 0) { await rm(dest, { force: true }); return null; }
    if (zipOnly) {
      const handle = await open(dest, 'r');
      const magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
      if (!(magic[0] === 0x50 && magic[1] === 0x4b &&
        ((magic[2] === 3 && magic[3] === 4) || (magic[2] === 5 && magic[3] === 6) || (magic[2] === 7 && magic[3] === 8)))) {
        await rm(dest, { force: true });
        log.warn(`[files] rejected non-ZIP from Files-in-chat name='${filename}'`);
        return null;
      }
    }
    log.info(`[files] downloaded from Files-in-chat name='${filename}' bytes=${info.size} path=${dest}`);
    return dest;
  } catch (error) {
    log.warn(`[files] Files-in-chat download failed name='${filename}': ${String(error)}`);
    return null;
  } finally {
    collector.stop();
    if (previewOpened) {
      const tab = page.getByRole('tab', { name: filename, exact: true });
      // The preview can be hosted beside the Files-in-chat pane; only close
      // a filename-specific tab, never the entire chat.
      const close = tab.getByRole('button', { name: /close/i }).first();
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    }
  }
}

async function retrieveFileFromControl(page: Page, file: ChatFile, directory: string): Promise<string> {
  const locator = page.locator(file.selector).nth(file.index);
  const previewSelectors = '[role="dialog"], [data-radix-dialog-content], [data-testid*="file-preview"], [data-testid*="preview-panel"]';
  const dialogsBefore = await page.locator(previewSelectors).filter({ visible: true }).count();
  const existingPages = new Set(page.context().pages());
  const collector = watchAttachmentDownloads(page);
  let viewer = page;
  let previewOpened = false;
  try {
    // Prefer the file-specific inline download link; a separate resource card
    // may open a preview rather than download and must not be treated as a
    // distinct file. Restrict matching to this message to avoid same-name files.
    const messageSelector = file.messageId ? `[data-dil-message-id="${file.messageId}"]` : '';
    const messageRegion = messageSelector ? page.locator(messageSelector).first() : page.locator('body');
    const directLink = messageRegion.getByRole('link', {
      name: `Open Download ${file.label}`, exact: true,
    }).first();
    const hasDirect = await directLink.count() > 0;
    if (hasDirect) {
      log.debug(`[files] trying explicit download link for '${file.label}'`);
      await directLink.click({ timeout: 5000 }).catch(error =>
        log.debug(`[files] inline download control click failed: ${String(error)}`));
    } else await locator.click({ timeout: 5000 });
    // First check downloads generated by the initial click. Do not assume a
    // download event must arrive within 1800 ms to be legitimate.
    let download = await collector.next(1100);
    const popup = page.context().pages().find(p => !existingPages.has(p) && !p.isClosed());
    if (popup) viewer = popup;
    const isPopup = viewer !== page;
    // The file tab is mounted asynchronously; give ChatGPT a short window
    // to mount it before falling back to attachment-card controls.
    let previewRoot = await openedFilePreviewRoot(viewer, isPopup ? 0 : dialogsBefore, isPopup, file.label);
    if (!download && !previewRoot) {
      for (let attempt = 0; attempt < 8 && !previewRoot; attempt++) {
        await page.waitForTimeout(250);
        previewRoot = await openedFilePreviewRoot(viewer, isPopup ? 0 : dialogsBefore, isPopup, file.label);
      }
    }
    previewOpened = !!previewRoot;
    if (!download && previewRoot) {
      // In the right-side viewer the icon-only Download button belongs to
      // [data-testid="viewer-header"], not the message attachment card.
      const headerAction = previewRoot.locator('[data-testid="viewer-header"]')
        .getByRole('button', { name: 'Download', exact: true }).first();
      const action = await headerAction.isVisible().catch(() => false) ? headerAction :
        previewRoot.getByRole('button', { name: /^download(?: file)?$/i }).first();
      const link = previewRoot.getByRole('link', { name: /^download(?: file)?$/i }).first();
      const target = await action.isVisible().catch(() => false) ? action : link;
      if (await target.isVisible().catch(() => false)) {
        try {
          log.info(`[files] clicking file preview Download name='${file.label}'`);
          await target.click({ timeout: 5000 });
          download = await collector.next(12_000);
        } catch (error) {
          log.debug(`[files] preview Download click failed for '${file.label}': ${String(error)}`);
          // A click can throw after starting a download; don't discard it.
          download = await collector.next(1500);
        }
      }
    }
    if (!download && !isPopup) {
      // The attachment card can remain usable even if the preview says
      // "Couldn't load this file". Never click a same-name card in another
      // message: many chats have successive revisions of the same filename.
      // Resolve by the stable owning message UUID first, then exact filename.
      const cardWasClicked = await page.evaluate(({ name, messageId }) => {
        const owner = messageId ? Array.from(document.querySelectorAll<HTMLElement>('[data-dil-message-id], [data-chatgpt-search-message-ids]'))
          .find(el => el.getAttribute('data-dil-message-id') === messageId ||
            (el.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).includes(messageId)) : null;
        if (!owner) return false; // Fail closed; never click an unrelated attachment.
        const buttons = Array.from(owner.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open preview of "]'));
        const preview = buttons.find(button => button.getAttribute('aria-label') === `Open preview of ${name}`);
        const row = preview?.parentElement;
        const target = row?.querySelector<HTMLButtonElement>('button[aria-label="Download file"]');
        if (!target || target.disabled || !target.getClientRects().length) return false;
        target.click();
        return true;
      }, { name: file.label, messageId: file.messageId }).catch(() => false);
      if (cardWasClicked) {
        log.debug(`[files] invoked owner-scoped resource-card Download for '${file.label}'`);
        download = await collector.next(12_000);
      }
    }
    await mkdir(directory, { recursive: true });
    const chooseTarget = (raw: string) => {
      const filename = fileNameForDownload(raw);
      const dest = path.join(directory, filename);
      return existsSync(dest) ? path.join(directory, `${crypto.randomUUID().slice(0, 8)}-${filename}`) : dest;
    };
    const save = async (event: Download) => {
      const target = chooseTarget(event.suggestedFilename() || file.label);
      await event.saveAs(target); // Wait for completed bytes, not just click.
      const info = await stat(target);
      if (!info.isFile()) throw new Error(`download target is not a file: ${target}`);
      log.info(`[files] downloaded chat-file name='${file.label}' path=${target} bytes=${info.size}`);
      return target;
    };
    if (download) return await save(download);
    const text = await readFilePreview(viewer, isPopup ? 0 : dialogsBefore, isPopup, file.label);
    if (text !== null) {
      // A late download still takes precedence over a text approximation.
      download = await collector.next(350);
      if (download) return await save(download);
      const label = /\.[a-z\d]{1,12}$/i.test(file.label) ? file.label : `${file.label}.txt`;
      const target = chooseTarget(label);
      await writeFile(target, text, 'utf8');
      log.info(`[files] saved preview text name='${file.label}' path=${target} chars=${text.length}`);
      return target;
    }
    // Some preview/download controls dispatch the event asynchronously while
    // the browser itself has already begun saving the attachment.
    download = await collector.next(5000);
    if (download) return await save(download);
    const previewUnavailable = await viewer.getByText(/(?:couldn[’']t|cannot|unable to) load (?:this |the )?file/i)
      .first().isVisible().catch(() => false);
    if (previewUnavailable) throw new Error(
      `'${file.label}' preview reports "Couldn't load this file" and the exact attachment's Download action produced no browser download. ChatGPT may no longer serve this attachment; try opening the original message or regenerating the file.`);
    throw new Error(`'${file.label}' yielded neither a captured browser download nor readable file preview`);
  } finally {
    collector.stop();
    if (viewer !== page) await viewer.close().catch(() => {});
    else if (previewOpened) {
      const active = await openedFilePreviewRoot(page, dialogsBefore, false, file.label);
      // File tabs have their own close button outside the tab panel. Do not
      // issue Escape on an unrelated chat when a file tab was opened.
      const fileTab = active && (await active.getAttribute('data-tab-id').catch(() => null))?.startsWith('chatgpt-file:');
      if (fileTab) {
        // Closing the viewer is optional; use its OWN header, not a global
        // Escape that could affect the chat composer or another file tab.
        const closeViewer = active!.locator('[data-testid="viewer-header"]')
          .getByRole('button', { name: 'Close viewer', exact: true }).first();
        if (await closeViewer.isVisible().catch(() => false))
          await closeViewer.click({ timeout: 1500 }).catch(() => {});
      }
      const close = fileTab ? null : active?.getByRole('button', { name: /close|dismiss/i }).first();
      if (close && await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 1000, force: true }).catch(() => page.keyboard.press('Escape').catch(() => {}));
      } else if (!fileTab) await page.keyboard.press('Escape').catch(() => {});
    }
  }
}

/** Scroll the actual conversation viewport rather than the largest scrollable
 * descendant (which may be a hidden sidebar or another unrelated pane). */
async function scrollChatHistoryUp(page: Page): Promise<{ moved: boolean; top: boolean; before: number; after: number; kind: string }> {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const message = Array.from(document.querySelectorAll<HTMLElement>('[data-chatgpt-search-message-ids]'))
      .find(visible);
    const main = message?.closest('main') || Array.from(document.querySelectorAll('main')).find(visible);
    const candidates: HTMLElement[] = [];
    // Ancestors of a mounted message are much more reliable than searching all
    // scrollable elements under main: internal cards can be independently scrollable.
    for (let node = message?.parentElement || main; node; node = node.parentElement) {
      if (node instanceof HTMLElement && visible(node)) candidates.push(node);
    }
    if (main && !candidates.includes(main)) candidates.push(main);
    if (document.scrollingElement instanceof HTMLElement) candidates.push(document.scrollingElement);
    const scrollers = candidates.filter(el => el.scrollHeight > el.clientHeight + 40 &&
      (el === document.scrollingElement || /auto|scroll|overlay/.test(getComputedStyle(el).overflowY)));
    // The innermost scrollable ancestor encompassing message units is the thread
    // scroller; avoid body/document if a dedicated thread scroller exists.
    const target = scrollers[0];
    if (!target) return { moved: false, top: false, before: 0, after: 0, kind: 'no-thread-scroller' };
    const before = target.scrollTop;
    const amount = Math.max(500, Math.round(target.clientHeight * 0.8));
    target.scrollTop = Math.max(0, before - amount);
    const after = target.scrollTop;
    return { moved: after < before, top: after <= 1, before, after,
      kind: target.tagName.toLowerCase() + (target.className && typeof target.className === 'string' ? '.' + target.className.split(/\s+/).slice(0, 2).join('.') : '') };
  });
}

/** Return a virtualized chat to its newest message after a historical read.
 * ChatGPT frequently replaces its transcript scroller while prepending history,
 * so saved Element references and old scrollHeight values cannot be trusted.
 * Resolve the live thread each pass and anchor to its bottom until layout settles.
 */
async function scrollChatHistoryToBottom(page: Page): Promise<void> {
  let lastKind = 'no-thread-scroller';
  let remaining = Infinity;
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await page.evaluate(() => {
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const message = Array.from(document.querySelectorAll<HTMLElement>('[data-chatgpt-search-message-ids]')).find(visible);
      const main = message?.closest('main') || Array.from(document.querySelectorAll('main')).find(visible);
      const candidates: HTMLElement[] = [];
      // Prefer the actual transcript scroller over an independently scrolling code block.
      for (const el of document.querySelectorAll<HTMLElement>('.thread-scroll-container')) {
        if (visible(el)) candidates.push(el);
      }
      for (let el = message?.parentElement || main; el; el = el.parentElement) {
        if (el instanceof HTMLElement && visible(el) && !candidates.includes(el)) candidates.push(el);
      }
      if (document.scrollingElement instanceof HTMLElement) candidates.push(document.scrollingElement);
      const scroller = candidates.find(el => el.scrollHeight > el.clientHeight + 40 &&
        (el === document.scrollingElement || /auto|scroll|overlay/.test(getComputedStyle(el).overflowY)));
      if (!scroller) return { remaining: 0, kind: 'no-thread-scroller' };
      scroller.scrollTop = scroller.scrollHeight;
      return {
        remaining: Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
        kind: scroller.tagName.toLowerCase() + (typeof scroller.className === 'string' ? '.' + scroller.className.split(/\s+/).slice(0, 2).join('.') : '')
      };
    });
    lastKind = state.kind;
    remaining = state.remaining;
    // Give React/virtualization a chance to remount the latest transcript window.
    await page.waitForTimeout(attempt < 3 ? 180 : 300);
    if (attempt >= 3 && remaining <= 3) {
      // Reapply once after the settling delay, in case scrollHeight grew.
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll<HTMLElement>('.thread-scroll-container'))
          .find(node => node.getClientRects().length > 0);
        if (el) el.scrollTop = el.scrollHeight;
      });
      break;
    }
  }
  log.debug(`[rescan] restored chat viewport to bottom scroller=${lastKind} remaining=${remaining}`);
}

/** A read-only file traversal must never be interpreted as a new ZIP event. */
const pagesReadingAttachmentHistory = new WeakSet<Page>();

/**
 * A rescan discovers historical assistant ZIPs, sometimes across multiple
 * virtualized DOM windows. Never interpret any of those files as new output.
 *
 * Page-level suppression ends when scrolling finishes; chat-level quarantine
 * deliberately survives it until an actual NEW user message is observed.
 * The Set contains IDs of every user message seen during that rescan, so a
 * window changing to an older user message cannot release the quarantine.
 * An empty Set means the rescan is still running (fail closed).
 */
const rescanHookQuarantine = new Map<string, Set<string>>();

/** Recover an indexed link from ChatGPT's virtualized history. */
async function findIndexedFileInHistory(page: Page, chatId: string, identity: string): Promise<ChatFile | null> {
  const scan = async (): Promise<ChatFile | null> => {
    const snapshot = await scrapeCurrentChat(page);
    if (!snapshot || snapshot.id !== chatId) throw new Error('file download chat mismatch');
    const files = await findChatFiles(page, snapshot.messages);
    const exact = files.find(f => f.identity === identity);
    if (exact) return exact;
    // Earlier versions indexed some labels with a different prefix. Only permit
    // fallback when message UUID and normalized filename uniquely identify a link.
    const parts = identity.split('|');
    const messageId = parts[0]?.toLowerCase();
    const label = parts.slice(1, -1).join('|');
    const equivalent = files.filter(f => f.messageId === messageId &&
      f.label.replace(/^Open\s+preview\s+of\s+/i, '').trim() === label);
    return equivalent.length === 1 ? equivalent[0]! : null;
  };
  const immediate = await scan();
  if (immediate) return immediate;
  let stagnant = 0;
  for (let step = 0; step < 120; step++) {
    const state = await scrollChatHistoryUp(page);
    log.debug(`[files] history scan chat=${chatId} step=${step + 1} scroller=${state.kind} top=${state.before}->${state.after} moved=${state.moved}`);
    if (!state.moved) {
      // Wheel events can trigger lazy history loaders whose DOM doesn't respond
      // to direct scrollTop assignment. Target the thread instead of the sidebar.
      const message = page.locator('[data-chatgpt-search-message-ids]:visible').first();
      if (await message.count()) {
        await message.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
        const box = await message.boundingBox();
        if (box) {
          await page.mouse.move(box.x + Math.min(box.width / 2, 80), box.y + Math.min(box.height / 2, 40));
          await page.mouse.wheel(0, -700);
        }
      }
    }
    await page.waitForTimeout(state.moved ? 380 : 750);
    const found = await scan();
    if (found) {
      log.info(`[files] recovered indexed attachment after upward history scan steps=${step + 1} chat=${chatId}`);
      return found;
    }
    if (state.top || !state.moved) stagnant++;
    else stagnant = 0;
    if (stagnant >= 8) {
      log.warn(`[files] history search exhausted at top chat=${chatId} identity=${identity} steps=${step + 1}`);
      break;
    }
  }
  return null;
}

async function downloadChatFile(page: Page, expectedChatId: string, identity: string, directory: string): Promise<string> {
  // The main watcher polls concurrently. A history retrieval may mount old ZIP
  // controls that must never trigger an auto-hook (even if new to the DOM).
  pagesReadingAttachmentHistory.add(page);
  try {
  // Remember scroll positions of the document and any inner thread scrollers.
  // Restore in finally even if a download, preview or history search fails.
  await page.evaluate(() => {
    const root = document.querySelector('main');
    const message = document.querySelector('[data-chatgpt-search-message-ids]');
    const ancestors: Element[] = [];
    for (let el = message?.parentElement; el; el = el.parentElement) ancestors.push(el);
    const elements = [document.scrollingElement, ...ancestors, root, ...Array.from(root?.querySelectorAll('*') || [])]
      .filter((el): el is Element => !!el);
    const state = elements.filter(el => (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 100)
      .map(el => ({ element: el, top: (el as HTMLElement).scrollTop,
        nearBottom: (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight - (el as HTMLElement).scrollTop < 80 }));
    // Keep element references inside the browser, not in serialized Playwright results.
    (window as unknown as { __ctlFileScrollState?: typeof state }).__ctlFileScrollState = state;
  });
  try {
    // The Files-in-chat menu is independent of transcript virtualization.
    // Try it first, then retain the older message-scoped retrieval path.
    const parts = identity.split('|');
    const requestedName = parts.slice(1, -1).join('|');
    if (requestedName) {
      const fromMenu = await downloadFromChatFilesPanel(page, requestedName, directory);
      if (fromMenu) return fromMenu;
    }
    const file = await findIndexedFileInHistory(page, expectedChatId, identity);
    if (!file) throw new Error(`indexed attachment '${identity}' not found after incremental history loading`);
    return await retrieveFileFromControl(page, file, directory);
  } finally {
    await page.evaluate(() => {
      const store = window as unknown as { __ctlFileScrollState?: Array<{ element: Element; top: number; nearBottom: boolean }> };
      for (const position of store.__ctlFileScrollState || []) {
        const el = position.element as HTMLElement;
        if (!el?.isConnected) continue;
        const restore = () => { if (el.isConnected) el.scrollTop = position.nearBottom ? el.scrollHeight : position.top; };
        restore();
        // Virtualized thread content can reflow after the first restoration.
        // Reapply only for elements originally near the bottom.
        if (position.nearBottom) { setTimeout(restore, 200); setTimeout(restore, 650); }
      }
      delete store.__ctlFileScrollState;
    }).catch(() => {});
  }
  } finally {
    pagesReadingAttachmentHistory.delete(page);
  }
}

/** Refresh a chat's complete history, including code and attachments.
 * Do not fire ZIP hooks: scrolling is for historical reads, not new output.
 * Accumulate mounted message windows before updating sequence numbers.
 */
async function rescanChatHistory(sql: Sql, page: Page, chatId: string, browserName: string): Promise<{messages: number; files: number; steps: number}> {
  pagesReadingAttachmentHistory.add(page);
  try {
    const seen = new Map<string, ScrapedMessage>();
    const orderedIds: string[] = [];
    const allFiles = new Map<string, ChatFile>();
    let steps = 0;
    let stagnant = 0;
    let lastCount = -1;
    for (let i = 0; i <= 180; i++) {
      const chat = await scrapeCurrentChat(page);
      if (!chat || chat.id !== chatId) throw new Error(`rescan chat mismatch: expected ${chatId}, got ${chat?.id}`);
      // Current window is chronologically ordered. New older messages go in
      // front; already-seen message IDs retain their relative position.
      const fresh = chat.messages.filter(m => !seen.has(m.id));
      orderedIds.unshift(...fresh.map(m => m.id));
      for (const m of chat.messages) seen.set(m.id, m);
      for (const f of await findChatFiles(page, chat.messages)) allFiles.set(f.identity, f);
      if (i === 180) break;
      const moved = await scrollChatHistoryUp(page);
      steps++;
      log.debug(`[rescan] chat=${chatId} step=${steps} scroller=${moved.kind} top=${moved.before}->${moved.after} moved=${moved.moved} messages=${seen.size} files=${allFiles.size}`);
      if (!moved.moved) {
        const element = page.locator('[data-chatgpt-search-message-ids]:visible').first();
        const box = await element.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.move(box.x + Math.min(box.width / 2, 80), box.y + Math.min(box.height / 2, 40));
          await page.mouse.wheel(0, -700);
        }
      }
      await page.waitForTimeout(moved.moved ? 350 : 700);
      if (moved.top || !moved.moved) {
        if (seen.size === lastCount) stagnant++; else stagnant = 0;
      } else stagnant = 0;
      lastCount = seen.size;
      if (stagnant >= 6) break;
    }
    // Stable normalized order across all virtualized windows, not per-window seq.
    const messages = orderedIds.map(id => seen.get(id)!).filter(Boolean);
    const snapshot = await scrapeCurrentChat(page);
    if (!snapshot) throw new Error('chat unloaded during rescan');
    const complete: ScrapedChat = { ...snapshot, messages: messages.map((m, sequence) => ({...m, sequence})) };
    await persistChat(sql, complete, 0, new Map(), browserName, true);
    // Persist all observed file windows, even those now unmounted from the DOM.
    for (const file of allFiles.values()) {
      await sql`INSERT INTO chatgpt_watcher_files
        (chat_id, identity, role, label, message_id, message_order, position, user_excerpt)
        VALUES (${chatId}, ${file.identity}, ${file.role}, ${file.label}, ${file.messageId},
          ${file.messageOrder}, ${file.position}, ${file.userExcerpt})
        ON CONFLICT (chat_id, identity) DO UPDATE SET
          label=EXCLUDED.label, user_excerpt=EXCLUDED.user_excerpt,
          message_order=EXCLUDED.message_order, position=EXCLUDED.position`;
    }
    // Arm the post-rescan hook barrier BEFORE lifting the page-level guard.
    // A regular watcher poll may run as soon as this method returns.
    rescanHookQuarantine.set(chatId, new Set(messages.filter(m => m.role === "user").map(m => m.id)));
    log.info(`[rescan] complete chat=${chatId} messages=${messages.length} files=${allFiles.size} steps=${steps}; automatic ZIP hooks quarantined until a NEW user turn`);
    return { messages: messages.length, files: allFiles.size, steps };
  } finally {
    // Rescan explicitly returns to the NEWEST messages, regardless of where
    // the user was before scanning. Keep hooks suppressed throughout cleanup.
    try {
      await scrollChatHistoryToBottom(page);
    } catch (error) {
      log.warn(`[rescan] failed to restore chat to bottom: ${formatError(error)}`);
    } finally {
      pagesReadingAttachmentHistory.delete(page);
    }
  }
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
type SuccessfulZip = { chatId: string; assistantId: string; turnOrder: number | null; targetIndex?: number; targetIdentity: string; label: string; savedAt: string };
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
    targetIndex: target.index,
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

/** Return only controls provably owned by an assistant message in this chat. */
function assistantZipTargets(targets: ZipTarget[], messages: ScrapedMessage[]): ZipTarget[] {
  const assistants = messages.filter((message) => message.role === "assistant");
  const users = messages.filter((message) => message.role === "user");
  return targets.filter((target) => {
    // Never accept a target associated with a known user message, even if a
    // DIL portal exposes conflicting turn metadata.
    if (users.some((message) => target.messageId && target.messageId === message.id.toLowerCase())) return false;
    if (target.messageId) {
      return assistants.some((message) => target.messageId === message.id.toLowerCase());
    }
    // No message UUID: only accept an unambiguous assistant turn.
    return target.messageOrder !== null &&
      assistants.some((message) => message.turnOrder === target.messageOrder) &&
      !users.some((message) => message.turnOrder === target.messageOrder);
  });
}

function newestZipFirst(a: ZipTarget, b: ZipTarget): number {
  return (b.messageOrder ?? -1) - (a.messageOrder ?? -1) || b.index - a.index;
}

/** Download the newest *verified* assistant ZIP and persist a per-chat cursor.
 * Older ZIPs are tried only if every more recent assistant-owned candidate
 * fails verification. A successful cursor is never moved backwards.
 */
async function downloadLastZip(page: Page, directory: string, _expectedAssistant?: AssistantZipIdentity, onlyNew = false, autoEligibleIdentities?: ReadonlySet<string>): Promise<string | null> {
  const chat = await scrapeCurrentChat(page);
  const chatId = chat?.id ?? normalizeUuid(page.url());
  if (!chat || !chatId) throw new Error("cannot identify conversation for assistant ZIP selection");
  const targets = assistantZipTargets(await findZipTargets(page), chat.messages).sort(newestZipFirst);
  if (!targets.length) throw new Error(`chat=${chatId} has no assistant-owned ZIP download controls`);
  const history = (await loadSuccessfulZips(directory))[chatId];
  // Cursor identity in the current assistant-only timeline takes precedence
  // over persisted turn/index, which may be stale after UI reflow. Manual
  // invocation always probes newest-first instead of replaying an old ZIP.
  const newestCandidates = zipTargetsAfterCursor(targets, history);
  // Automatic triggers are based on newly observed assistant-owned controls.
  // An archive can arrive later in the SAME assistant turn, and the saved
  // cursor's anchor may disappear after ChatGPT re-renders the timeline.
  // In both situations a strict turn/index cursor would incorrectly hide it.
  const candidates = autoEligibleIdentities
    ? targets.filter((target) => autoEligibleIdentities.has(target.identity))
    : onlyNew ? newestCandidates : targets;
  log.info(`[download] chat=${chatId} assistantCandidates=${targets.length} newCandidates=${newestCandidates.length} lastSuccess=${history?.label ?? "none"}`);
  if (candidates.length === 0) {
    log.debug(`[download] chat=${chatId} no ZIP newer than saved cursor; nothing to do`);
    return null;
  }

  // Process newest to oldest, not "first to finish"; concurrent probing would
  // otherwise select an older ZIP just because its download completed first.
  const errors: string[] = [];
  for (const target of candidates) {
    const archive = await downloadZipTarget(page, target, directory);
    if (!archive) { errors.push(`${target.label}: not a downloadable ZIP`); continue; }
    const assistant = chat.messages.find((message) => message.role === "assistant" &&
      (message.id.toLowerCase() === target.messageId ||
       (!target.messageId && message.turnOrder === target.messageOrder)));
    const newTurn = target.messageOrder ?? assistant?.turnOrder ?? null;
    // Manual runs can inspect older archives when newer candidates are not
    // downloadable, but only actual forward progress may advance the cursor.
    const replay = history?.targetIdentity === target.identity;
    const advances = autoEligibleIdentities?.has(target.identity) || !history || zipTargetIsAfterCursor(target, targets, history);
    if (advances) {
      await persistSuccessfulZip(directory, chatId, assistant ? {id: assistant.id, turnOrder: assistant.turnOrder} : undefined, target);
      log.info(`[download] cursor advanced chat=${chatId} assistant=${assistant?.id ?? target.messageId} turn=${newTurn} file='${target.label}'`);
    } else {
      log.info(`[download] ${replay ? "replaying" : "using historical"} verified ZIP chat=${chatId} file='${target.label}' (cursor retained)`);
    }
    return archive;
  }
  throw new Error(`no assistant-owned candidate yielded a verified ZIP (${errors.join("; ")})`);
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
    // Wait for the UI to recognize the attachment; don't scrape chat history.
    // A fixed delay alone can cause the Send button to fire before upload.
    await page.waitForTimeout(1000);
  }
  if (text.trim()) await composer.fill(text);
  const sendButtonSelector = 'button[data-testid="send-button"], button[aria-label="Send message" i], button[aria-label="Send" i], button[data-composer-navigation-target="send"]';
  // Never click a Send control belonging to an unrelated mounted composer.
  // ChatGPT may render multiple visible editor surfaces (side panels included).
  const form = composer.locator('xpath=ancestor::form[1]');
  const scopedSend = form.locator(sendButtonSelector).filter({ visible: true });
  const fallbackSend = page.locator(sendButtonSelector).filter({ visible: true });
  const chooseSendButton = async () => {
    const inForm = await scopedSend.count();
    return inForm ? scopedSend.last() : fallbackSend.last();
  };
  if (!submit) {
    // Drafts do not need a Send button: ChatGPT may hide it while the file is
    // being processed or while the composer contains only an attachment.
    log.info(`[send] draft prepared text_chars=${text.length} files=${files.length} url=${page.url()}`);
    return;
  }
  const readySendButton = await chooseSendButton();
  await readySendButton.waitFor({ state: "visible", timeout: 8000 });
  await readySendButton.waitFor({ state: "attached", timeout: 8000 });

  // A click resolving does NOT mean a message was submitted. Capture the
  // current user-message identities first, and confirm a genuinely new message
  // containing this report before logging success. This prevents silent draft
  // retention and accidental duplicate submission after a slow UI response.
  // Lightweight acknowledgement: examine only the last few *user* bubbles,
  // not every message and code block in a potentially massive conversation.
  // Full scrapeCurrentChat() on every 400ms poll freezes long chat panes.
  const expected = text.replace(/\s+/g, " ").trim().slice(0, 110);
  const userMessageSnapshot = async () => page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-message-author-role="user"]');
    const last = nodes[nodes.length - 1];
    return { count: nodes.length, id: last?.getAttribute("data-message-id") || "",
      text: (last?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150) };
  });
  const initial = await userMessageSnapshot();
  const composerText = async () => composer.evaluate(element =>
    element instanceof HTMLTextAreaElement ? element.value : (element.textContent || "")
  ).catch(() => "");
  const observed = async () => {
    const last = await userMessageSnapshot().catch(() => null);
    return Boolean(last && (last.count > initial.count ||
      (last.id && last.id !== initial.id)) &&
      (!expected || last.text.startsWith(expected)));
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    let clickError: unknown;
    try {
      const button = await chooseSendButton();
      await button.waitFor({ state: "visible", timeout: 8_000 });
      await button.click({ timeout: 8_000 });
    } catch (error) {
      clickError = error;
      log.warn(`[send] submit click attempt=${attempt} failed: ${formatError(error)}`);
    }
    const deadline = Date.now() + 12_000;
    let emptied = false;
    while (Date.now() < deadline) {
      if (await observed()) {
        log.info(`[send] confirmed submitted attempt=${attempt} text_chars=${text.length} files=${files.length} url=${page.url()}`);
        return;
      }
      const draft = await composerText();
      if (!draft.trim()) emptied = true;
      await page.waitForTimeout(900);
    }
    // Empty composer without a new message is *ambiguous*: ChatGPT may still
    // be committing it. Do not risk sending an identical diagnostic twice.
    if (emptied || !(await composerText()).trim()) {
      throw new Error(`send: composer cleared but no matching user message was observed after attempt ${attempt}; submission uncertain (no automatic retry)`);
    }
    if (await observed()) {
      log.info(`[send] confirmed submitted after delayed render attempt=${attempt}`);
      return;
    }
    if (clickError && attempt === 3) throw clickError;
    log.warn(`[send] no user message after attempt=${attempt}; draft remains in composer; retrying`);
  }
  throw new Error("send: report remained in composer after 3 submit attempts; not confirmed sent");
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
  // Extract into a temporary sibling inside the project first, validate the
  // materialized files, and only then publish them into the build tree.
  // A successful `unzip` command alone does not prove that the configured
  // child_folder received the expected new sources.
  const flattenRoot = Boolean(singleRoot && normalizedEntries.some((entry) => entry.startsWith(`${singleRoot}/`)));
  const stagedPaths = normalizedEntries
    .map((entry) => flattenRoot && singleRoot
      ? (entry === singleRoot ? "" : entry.startsWith(`${singleRoot}/`) ? entry.slice(singleRoot.length + 1) : entry)
      : entry)
    .filter(Boolean);
  const stagedFiles = [...new Set(stagedPaths.filter((entry) => !entry.endsWith("/") && entry !== "."))];
  const extractStarted = performance.now();
  log.info(`[hook] extract START chat=${chatId} archive=${path.basename(archive)} destination=${projectDir} child_folder=${hook.child_folder || "."} zip_entries=${entries.length} flattened_root=${flattenRoot ? singleRoot : "none"}`);
  const staging = await mkdtemp(path.join(projectDir, ".chatgpt-ctl-hook-unzip-"));
  try {
    const extract = await commandOutput(["unzip", "-o", "-q", archive, "-d", staging]);
    if (extract.code !== 0) throw new Error(`ZIP extraction failed: ${extract.stderr}`);
    const extractedRoot = flattenRoot && singleRoot ? path.join(staging, singleRoot) : staging;
    const toHash = [
      "package.json", "ctl/Cargo.toml", "ctl/src/main.rs", "src/index.ts", "flake.nix",
      ...stagedFiles,
    ].filter((item, index, all) => all.indexOf(item) === index && stagedFiles.includes(item)).slice(0, 8);
    const expectedHashes = new Map<string, string>();
    for (const entry of toHash) {
      const source = path.resolve(extractedRoot, entry);
      const relative = path.relative(extractedRoot, source);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`unsafe extracted path: ${entry}`);
      const content = await readFile(source);
      expectedHashes.set(entry, createHash("sha256").update(content).digest("hex"));
    }
    await mergeDirectoryContents(extractedRoot, projectDir);
    // Verify the exact bytes of representative source files before build.
    // This detects an incorrect extraction root or merge silently writing
    // sources elsewhere, which can otherwise look like a stale build.
    for (const [entry, digest] of expectedHashes) {
      const written = await readFile(path.resolve(projectDir, entry));
      if (createHash("sha256").update(written).digest("hex") !== digest) {
        throw new Error(`extracted file verification failed: ${entry}`);
      }
    }
    log.info(`[hook] extract FINISHED chat=${chatId} archive=${path.basename(archive)} destination=${projectDir} files=${stagedFiles.length} verified=${expectedHashes.size} duration_ms=${Math.round(performance.now() - extractStarted)}`);
  } catch (error) {
    log.error(`[hook] extract FAILED chat=${chatId} archive=${path.basename(archive)} destination=${projectDir}: ${String(error)}`);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const buildDir = path.resolve(projectDir, hook.child_folder || ".");
  const buildRelative = path.relative(projectDir, buildDir);
  if (buildRelative.startsWith("..") || path.isAbsolute(buildRelative)) {
    throw new Error(`hook child_folder escapes project folder: ${hook.child_folder}`);
  }
  if (!(await lstat(buildDir).catch(() => null))?.isDirectory()) {
    throw new Error(`hook build directory does not exist after ZIP extraction: ${buildDir}`);
  }
  log.info(`[hook] build sources ready chat=${chatId} project=${projectDir} cwd=${buildDir} archive=${path.basename(archive)}`);
  const archiveFiles: string[] = [];
  for (const entry of [...new Set(stagedPaths)]) {
    if (!entry || entry === "." || entry.endsWith("/")) continue;
    const absolute = path.resolve(projectDir, entry);
    const relative = path.relative(projectDir, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`unsafe staged archive path rejected: ${entry}`);
    // Keep deleted paths: Git may need to stage their removal.
    archiveFiles.push(relative.split(path.sep).join("/"));
  }

  // Query Git's *own* index + exclude engine. Unlike git check-ignore followed
  // by git add, this also handles ignored parent directories and nested rules.
  // Tracked files stay eligible even if a new ignore rule matches them.
  const pathspecs = archiveFiles.map((file) => `:(literal)${file}`);
  let eligiblePaths: string[] | undefined;
  async function stageArchiveFiles(): Promise<string[]> {
    if (!pathspecs.length) return [];
    const ls = await commandOutput(
      ["git", "-C", projectDir, "ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "--", ...pathspecs],
      undefined, "", // Preserve NUL-separated output.
    );
    if (ls.code !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
    const allowed = [...new Set(ls.stdout.split("\0").filter(Boolean))];
    const allowedSet = new Set(allowed);
    const skipped = archiveFiles.filter((name) => !allowedSet.has(name));
    if (skipped.length) log.info(`[hook] skipped ${skipped.length} ignored or untracked-in-nested-repo file(s): ${skipped.join(", ")}`);
    if (allowed.length) {
      const result = await commandOutput(["git", "-C", projectDir, "add", "-A", "--", ...allowed.map((name) => `:(literal)${name}`)]);
      if (result.code !== 0) throw new Error(`git add failed: ${result.stderr || result.stdout}`);
    }
    log.info(`[hook] git-add staged eligible archive paths=${allowed.length} chat=${chatId}`);
    return allowed;
  }

  // A stored legacy "wcc build" value represents the old default. Resolve it
  // through config.toml, without overriding explicit custom per-chat commands.
  const hookDefaults = (await loadConfig(configPath)).hooks;
  const defaultBuildCommand = hookDefaults?.default_build_command?.trim() || "wcc build -o";
  const failureReportMaxChars = Math.max(1024, Math.min(24000, hookDefaults?.failure_report_max_chars ?? 6500));
  const stages = hook.stages;
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index]!;
    const label = `${index + 1}/${stages.length} ${stage.type}`;
    const started = performance.now();
    log.info(`[hook] stage START chat=${chatId} stage=${label} cwd=${stage.type === "custom" || stage.type === "build" ? buildDir : projectDir}`);
    if (stage.type === "build" || stage.type === "custom") {
      const shellCommand = stage.type === "build"
        ? (hook.build_command === "wcc build" ? defaultBuildCommand : hook.build_command)
        : stage.command;
      if (!shellCommand?.trim() || shellCommand.trim().toLowerCase() === "none") {
        log.info(`[hook] stage SKIP chat=${chatId} stage=${label} (no command)`);
        continue;
      }
      const command = hook.nix_flake
        ? ["nix", "develop", buildDir, "-c", "sh", "-lc", shellCommand]
        : ["sh", "-lc", shellCommand];
      log.info(`[hook] command START chat=${chatId} stage=${label} command=${JSON.stringify(command)} archive=${path.basename(archive)}`);
      const result = await commandOutput(command, buildDir);
      log.info(`[hook] command FINISHED chat=${chatId} stage=${label} exit=${result.code} duration_ms=${Math.round(performance.now() - started)}${result.stderr ? ` stderr=${result.stderr.slice(-1000)}` : ""}`);
      if (result.code !== 0) {
        if (stage.type === "build") {
          // `wcc build -o` prints the same clean output that wcc copies to the
          // clipboard. stdout is the primary source; stderr is only a fallback.
          // Never invoke wl-paste: its output is stale and can block on Wayland.
          const diagnostic = result.stdout || result.stderr ||
            `build command failed with exit code ${result.code}`;
          // failure_report_max_chars is an INLINE threshold, never a truncation
          // limit. Preserve complete stdout (or stderr fallback) in a local file
          // before attempting to upload, so no compiler diagnostics are lost.
          const heading = `Build failed (exit code ${result.code}). Pipeline stopped at ${label}.`;
          let report = `${heading}\n\n${diagnostic}`;
          const attachments: string[] = [];
          if (report.length > failureReportMaxChars) {
            const logsDir = resolveFromConfig(configPath, "./var/build-logs");
            await mkdir(logsDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const logFile = path.join(logsDir, `build-${chatId}-${stamp}.log`);
            await writeFile(logFile, `${heading}\nCommand: ${shellCommand}\n\n${diagnostic}\n`, "utf8");
            attachments.push(logFile);
            report = `${heading}\nFull build output attached as ${path.basename(logFile)} (${Buffer.byteLength(diagnostic, "utf8")} bytes).`;
            log.info(`[hook] complete build log saved chat=${chatId} path=${logFile} bytes=${Buffer.byteLength(diagnostic, "utf8")}`);
          }
          log.info(`[hook] sending build diagnostic chat=${chatId} inline_chars=${report.length} attachments=${attachments.length}`);
          try {
            await sendInPage(page, report, chatId, attachments);
          } catch (sendError) {
            log.error(`[hook] failed to send build diagnostic chat=${chatId} saved_log=${attachments[0] || "inline"}: ${formatError(sendError)}`);
          }
        }
        throw new Error(`hook ${label} failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-1800)}`);
      }
    } else if (stage.type === "git-add") {
      eligiblePaths = await stageArchiveFiles();
    } else if (stage.type === "git-commit") {
      // Commit the index, not --only pathspecs: custom stages may stage files.
      const diff = await commandOutput(["git", "-C", projectDir, "diff", "--cached", "--quiet"]);
      if (diff.code === 0) {
        log.info(`[hook] stage SKIP chat=${chatId} stage=${label} (no staged changes)`);
        continue;
      }
      if (diff.code !== 1) throw new Error(`git diff --cached failed: ${diff.stderr}`);
      const mdPaths = (eligiblePaths || archiveFiles).filter((name) => name.toLowerCase().endsWith(".md"));
      const mdDiff = mdPaths.length
        ? await commandOutput(["git", "-C", projectDir, "diff", "--cached", "--", ...mdPaths.map((name) => `:(literal)${name}`)])
        : { code: 0, stdout: "", stderr: "" };
      if (mdDiff.code !== 0) throw new Error(`git diff markdown failed: ${mdDiff.stderr}`);
      const message = (mdDiff.stdout || "Auto update").slice(0, 18000);
      const commit = await commandOutput(["git", "-C", projectDir, "commit", "-m", message]);
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
      log.info(`[hook] git commit created chat=${chatId}`);
    }
    log.info(`[hook] stage FINISHED chat=${chatId} stage=${label} duration_ms=${Math.round(performance.now() - started)}`);
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
  const archiveDir = path.resolve(resolveFromConfig(configPath, hook.folder), ".chatgpt-ctl-downloads");
  // Compare the latest ZIP in the chat's Files menu to the most recent
  // assistant-owned ZIP in the conversation. If their filenames differ, use
  // the Files-menu archive first; otherwise preserve the existing ZIP cursor.
  const current = await scrapeCurrentChat(page);
  const chatTargets = current ? assistantZipTargets(await findZipTargets(page), current.messages).sort(newestZipFirst) : [];
  const selectedChatZip = chatTargets.find(target => /\.zip(?:$|[?#\s])/i.test(target.label));
  const menuNames = await filePanelNames(page);
  const menuZip = menuNames.find(name => /\.zip$/i.test(name));
  let archive: string | null = null;
  if (menuZip && selectedChatZip && fileNameForDownload(menuZip).toLowerCase() !==
      fileNameForDownload(selectedChatZip.label).toLowerCase()) {
    log.info(`[hook] Files-in-chat ZIP differs from latest assistant ZIP menu='${menuZip}' chat='${selectedChatZip.label}'; preferring menu`);
    archive = await downloadFromChatFilesPanel(page, menuZip, archiveDir, true);
  } else if (menuZip && !selectedChatZip) {
    log.info(`[hook] no visible assistant ZIP; trying Files-in-chat ZIP='${menuZip}'`);
    archive = await downloadFromChatFilesPanel(page, menuZip, archiveDir, true);
  }
  if (!archive) {
    try {
      archive = await downloadLastZip(page, archiveDir);
    } catch (error) {
      // The files index recognizes more ChatGPT layouts than the older ZIP
      // scanner. Reuse its assistant-owned controls, but never run an
      // unverified download or a user-uploaded archive as a build hook.
      log.warn(`[hook] primary ZIP selection failed chat=${chatId}: ${String(error)}`);
      const snapshot = await scrapeCurrentChat(page);
      const files = snapshot ? (await findChatFiles(page, snapshot.messages))
        .filter(file => file.role === "assistant" && /\.zip(?:$|[?#\s])|\bZIP\b/i.test(file.label))
        .sort((a, b) => (b.messageOrder ?? -1) - (a.messageOrder ?? -1) || b.position - a.position) : [];
      for (const file of files) {
        try {
          const found = await retrieveFileFromControl(page, file, archiveDir);
          const handle = await open(found, "r");
          const magic = Buffer.alloc(4);
          try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
          if (magic[0] === 0x50 && magic[1] === 0x4b &&
            ((magic[2] === 3 && magic[3] === 4) || (magic[2] === 5 && magic[3] === 6) || (magic[2] === 7 && magic[3] === 8))) {
            log.info(`[hook] recovered verified ZIP from indexed assistant file chat=${chatId} label='${file.label}'`);
            archive = found;
            break;
          }
          await rm(found, { force: true });
        } catch (failure) {
          log.warn(`[hook] indexed ZIP candidate failed chat=${chatId} label='${file.label}': ${String(failure)}`);
        }
      }
      if (!archive) throw error;
    }
  }
  if (!archive) throw new Error(`chat=${chatId}: no ZIP available to run`);
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

/** Save a complete DOM snapshot of the foreground browser pane without changing it. */
async function saveFocusedHtmlSnapshot(page: Page, browserName: string, directory: string): Promise<string> {
  const html = await page.content();
  const chatId = normalizeUuid(page.url()) ?? "page";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeBrowser = browserName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `chatgpt-${safeBrowser}-${chatId}-${stamp}.html`;
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, filename);
  // Exclusive creation prevents snapshots taken within the same millisecond overwriting one another.
  await writeFile(destination, html, { flag: "wx" });
  log.info(`[snapshot] saved browser=${browserName} chat=${chatId} bytes=${Buffer.byteLength(html)} file=${destination}`);
  return destination;
}

async function installFocusTracking(runtime: BrowserRuntime, focus: VirtualFocus, cfg: Config) {
  const snapshotShortcut = (cfg.snapshots?.hotkey ?? "Alt+Shift+H").trim();
  const snapshotDirectory = path.resolve(process.cwd(), cfg.snapshots?.directory || ".");
  // The shortcut is evaluated in the browser, not the Zellij/terminal key stream.
  // Empty/"off" disables it. Multiple modifiers are supported, including Ctrl/Meta.
  const keys = snapshotShortcut.toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
  const hotkeyEnabled = snapshotShortcut !== "" && snapshotShortcut.toLowerCase() !== "off";
  const hotkeyKey = keys.at(-1) ?? "";
  const allowedModifiers = new Set(["ctrl", "control", "alt", "shift", "meta", "cmd"]);
  if (hotkeyEnabled && (!/^[a-z0-9]$/.test(hotkeyKey) || keys.slice(0, -1).some(key => !allowedModifiers.has(key)))) {
    throw new Error(`Invalid snapshots.hotkey '${snapshotShortcut}' (example: Alt+Shift+H)`);
  }
  await runtime.context.exposeBinding("__chatgptWatcherSaveHtmlSnapshot", async (source) => {
    const page = source.page;
    if (page.isClosed() || focus.restoring) return;
    const isForeground = await page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()).catch(() => false);
    if (!isForeground) return;
    try {
      setVirtualFocus(focus, runtime, page, "manual");
      await saveFocusedHtmlSnapshot(page, runtime.name, snapshotDirectory);
    } catch (error) {
      log.error(`[snapshot] browser=${runtime.name} save failed: ${formatError(error)}`);
    }
  });
  // The browser itself is authoritative: no desktop/window-manager IPC or
  // background reconciliation loop is needed. Do not clear virtual focus when
  // the user switches to a terminal or another application.
  await runtime.context.exposeBinding("__chatgptCtlPageFocused", (source) => {
    const page = source.page;
    if (!focus.restoring && !page.isClosed() && normalizeUuid(page.url())) {
      if (focus.page !== page || focus.runtime !== runtime) {
        setVirtualFocus(focus, runtime, page, "manual");
        log.debug(`[focus] browser=${runtime.name} chat=${normalizeUuid(page.url())} selected`);
      }
    }
  });

  const installListeners = (shortcut: { enabled: boolean; key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }) => {
    const notify = () => {
      // A background tab's focus handler must not steal virtual focus.
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const callback = (window as any).__chatgptCtlPageFocused;
      if (typeof callback === "function") void callback();
    };
    // Run once per document, including pages restored after navigation.
    const key = "__chatgptCtlFocusListenersInstalled";
    if ((window as any)[key]) return;
    (window as any)[key] = true;
    if (shortcut.enabled) {
      window.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.repeat || event.isComposing || document.visibilityState !== "visible" || !document.hasFocus()) return;
        if (event.key.toLowerCase() !== shortcut.key || event.ctrlKey !== shortcut.ctrl ||
            event.altKey !== shortcut.alt || event.shiftKey !== shortcut.shift || event.metaKey !== shortcut.meta) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const callback = (window as any).__chatgptWatcherSaveHtmlSnapshot;
        if (typeof callback === "function") void callback();
      }, true);
    }
    window.addEventListener("focus", notify);
    document.addEventListener("visibilitychange", notify);
    window.addEventListener("pageshow", notify);
    document.addEventListener("focusin", notify);
  };
  const shortcutOptions = {
    enabled: hotkeyEnabled,
    key: hotkeyKey,
    ctrl: keys.includes("ctrl") || keys.includes("control"),
    alt: keys.includes("alt"),
    shift: keys.includes("shift"),
    meta: keys.includes("meta") || keys.includes("cmd"),
  };
  await runtime.context.addInitScript(installListeners, shortcutOptions);

  const attachPage = (page: Page) => {
    void page.evaluate(installListeners, shortcutOptions).catch(() => undefined);
    const markWhenActuallyFocused = async () => {
      const focused = await page.evaluate(() =>
        document.visibilityState === "visible" && document.hasFocus()
      ).catch(() => false);
      if (!focus.restoring && focused && !page.isClosed() && normalizeUuid(page.url()) &&
          (focus.page !== page || focus.runtime !== runtime)) {
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
  for (const page of runtime.context.pages()) attachPage(page);
}

type ProjectChat = { id: string; title: string; order: number };
const projectSlugPattern = /^g-p-[a-z0-9]+$/i;
const projectFromUrl = (url: string): string | null => url.match(/\/g\/(g-p-[a-z0-9]+)(?:\/|$)/i)?.[1] ?? null;

async function projectForBrowser(sql: Sql, browserName: string): Promise<string | null> {
  const rows = await sql`SELECT default_project FROM chatgpt_watcher_browsers WHERE name=${browserName}`;
  return rows[0]?.default_project ? String(rows[0].default_project) : null;
}

// Project selection is restricted to genuine ChatGPT /g/ links. A title is
// resolved through the currently rendered project links, not URL guesswork.
async function resolveProject(page: Page, selector: string): Promise<{id:string; name:string}> {
  const candidate = selector.trim();
  const fromUrl = projectFromUrl(candidate);
  const slug = projectSlugPattern.test(candidate) ? candidate : fromUrl;
  const links = await page.locator('a[href*="/g/g-p-"][href$="/project"]').evaluateAll(nodes =>
    nodes.filter(node => (node as HTMLElement).getClientRects().length > 0).map(node => ({
      href: (node as HTMLAnchorElement).getAttribute('href') || '',
      name: (node.textContent || '').trim(),
    }))
  );
  const match = links.find(link => projectFromUrl(link.href) === slug) ||
    links.find(link => link.name.toLowerCase() === candidate.toLowerCase());
  if (match) return {id: projectFromUrl(match.href)!, name: match.name || candidate};
  if (slug) return {id: slug, name: candidate};
  throw new Error(`Project '${selector}' not found in visible project links. Open that project in ChatGPT first, or supply its /g/.../project URL.`);
}

async function enumerateProjectChats(page: Page, projectId: string, baseUrl: string): Promise<ProjectChat[]> {
  const route = `/g/${projectId}/project`;
  await page.goto(new URL(route, baseUrl).toString(), {waitUntil:'domcontentloaded', timeout:45000});

  // Project pages use a separate sidebar state for each tab. Do not mistake a
  // collapsed sidebar, or a not-yet-hydrated list, for the end of pagination.
  const listSelector = '[role="list"][aria-label^="Chats in "]';
  const list = page.locator(`${listSelector}:visible`).first();
  if (!await list.isVisible().catch(() => false)) {
    const sidebarTrigger = page.locator('[data-app-shell-sidebar-trigger][aria-expanded="false"]:visible').first();
    if (await sidebarTrigger.count()) await sidebarTrigger.click();
  }
  await list.waitFor({state:'visible',timeout:30000});
  const chatSelector = `a[href*="/g/${projectId}/c/"]`;
  const showMoreSelector = '[role="listitem"] button';
  await list.locator(`${chatSelector}, ${showMoreSelector}`).first()
    .waitFor({state:'attached',timeout:20000});

  let clicks = 0;
  let previousCount = await list.locator(chatSelector).count();
  log.info(`[rescan-all] inventory BEGIN project=${projectId} initial_chats=${previousCount}`);
  if (!previousCount) throw new Error(`Project ${projectId} displayed zero chats; refusing to mark inventory complete`);

  for (let step = 0; step < 2000; step++) {
    // Use the project list ONLY: messages and unrelated sidebar sections also
    // have buttons titled "Show more".
    const more = list.locator(showMoreSelector).filter({hasText:/^\s*Show more\s*$/i}).first();
    if (!await more.count()) {
      // Allow time for asynchronous pagination to settle. Recheck the same
      // project list before certifying that there are no more pages.
      // Allow the sidebar to populate its lazily loaded footer before
      // deciding pagination has ended. The project list can initially
      // render only five chats while its Show more control hydrates.
      await list.evaluate(el => {
        const scroll = el.closest('[data-app-action-sidebar-scroll]');
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
      }).catch(() => {});
      await page.waitForTimeout(1500);
      if (!await more.count()) {
        log.info(`[rescan-all] inventory COMPLETE project=${projectId} chats=${previousCount} show_more_clicks=${clicks} pagination_exhausted=true`);
        break;
      }
    }
    if (!await more.isVisible()) {
      // A present but hidden pagination button means the inventory is NOT
      // complete. Opening the sidebar may be needed in a newly created tab.
      const trigger = page.locator('[data-app-shell-sidebar-trigger][aria-expanded="false"]:visible').first();
      if (await trigger.count()) await trigger.click();
      await more.scrollIntoViewIfNeeded().catch(() => {});
      if (!await more.isVisible()) throw new Error(`Project ${projectId}: Show more exists but is hidden; inventory incomplete`);
    }
    await more.scrollIntoViewIfNeeded();
    log.info(`[rescan-all] inventory click Show more project=${projectId} click=${clicks+1} chats_before=${previousCount}`);
    await more.click({timeout:15000});
    clicks++;
    // Explicitly wait for MORE entries, not simply for a fixed delay.
    const deadline = Date.now() + 15000;
    let count = previousCount;
    while (Date.now() < deadline) {
      count = await list.locator(chatSelector).count();
      if (count > previousCount) break;
      await page.waitForTimeout(200);
    }
    if (count <= previousCount) {
      throw new Error(`Project ${projectId}: Show more click ${clicks} added no chats after 15s (still ${count}); inventory incomplete`);
    }
    log.info(`[rescan-all] inventory expanded project=${projectId} click=${clicks} chats=${count}`);
    previousCount = count;
    if (step === 1999) throw new Error(`Project ${projectId}: exceeded 2000 Show more clicks; inventory incomplete`);
  }
  const rows = await list.locator(chatSelector).evaluateAll(anchors => anchors.map(a => ({
    url:(a as HTMLAnchorElement).getAttribute('href')||'', title:(a.getAttribute('aria-label')||a.textContent||'').trim()
  })));
  const result: ProjectChat[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.url.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
    if (!id || ids.has(id)) continue;
    ids.add(id);
    result.push({id,title:row.title,order:result.length});
  }
  if (result.length !== rows.length) throw new Error(`Project ${projectId}: ${rows.length} links but only ${result.length} distinct chat IDs; inventory incomplete`);
  return result;
}

function startControlServer(
  runtimes: BrowserRuntime[],
  focus: VirtualFocus,
  cfg: Config,
  configPath: string,
  sql: Sql,
  ensureRuntimeForChat: (chatId: string) => Promise<BrowserRuntime>,
) {
  const chooseDefaultRuntime = () => runtimes.find((runtime) => runtime.name === "default") ?? runtimes[0];
  const makePage = async (runtime: BrowserRuntime): Promise<Page> => {
    const page = await runtime.context.newPage();
    configurePage(page, cfg);
    attachNetworkDebug(page, cfg);
    runtime.activePage = page;
    return page;
  };
  const newChatTarget = async (runtime: BrowserRuntime): Promise<string> => {
    const project = await projectForBrowser(sql,runtime.name);
    return new URL(project ? `/g/${project}/project` : '/', cfg.chatgpt.url).toString();
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
          chat_id?: string; message_id?: string; chat?: string; directory?: string; extract_to?: string; identity?: string;
          text?: string; files?: string[]; new_chat?: boolean; draft?: boolean; browser_name?: string; project?: string; project_id?: string; project_order?: number;
        };
        if (url.pathname === "/project/default") {
          const browserName = body.browser_name || focus.runtime?.name || chooseDefaultRuntime()?.name;
          const runtime = runtimes.find(r => r.name === browserName);
          if (!runtime) return Response.json({error:`browser '${browserName}' not running`},{status:404});
          if (typeof body.project === 'string') {
            if (!body.project.trim() || body.project.toLowerCase()==='none' || body.project.toLowerCase()==='clear') {
              await sql`UPDATE chatgpt_watcher_browsers SET default_project=NULL WHERE name=${runtime.name}`;
            } else {
              const source = focus.runtime===runtime && focus.page && !focus.page.isClosed()
                ? focus.page : runtime.context.pages().find(p=>!p.isClosed()) || await makePage(runtime);
              const selected = await resolveProject(source,body.project);
              await sql`UPDATE chatgpt_watcher_browsers SET default_project=${selected.id}, updated_at=NOW() WHERE name=${runtime.name}`;
            }
          }
          return Response.json({ok:true,browser_name:runtime.name,default_project:await projectForBrowser(sql,runtime.name)});
        }
        if (url.pathname === "/rescan-all/list") {
          const runtime = body.browser_name
            ? runtimes.find(r=>r.name===body.browser_name)
            : focus.runtime || chooseDefaultRuntime();
          if (!runtime) return Response.json({error:'browser not available'},{status:404});
          const selector = body.project || await projectForBrowser(sql,runtime.name);
          if (!selector) return Response.json({error:'No project specified or configured; run ctl default-project PROJECT first'},{status:400});
          const listingPage = await runtime.context.newPage();
          configurePage(listingPage,cfg);
          pagesReadingAttachmentHistory.add(listingPage);
          try {
            const landing = focus.runtime===runtime && focus.page && !focus.page.isClosed()
              ? focus.page : runtime.context.pages().find(p=>p!==listingPage && !p.isClosed());
            // Project slugs and URLs are accepted even when the sidebar is collapsed.
            const resolved = await resolveProject(landing || listingPage,selector);
            const chats = await enumerateProjectChats(listingPage,resolved.id,cfg.chatgpt.url);
            // Persist the complete inventory BEFORE starting individual scans.
            for (const item of chats) {
              await sql`INSERT INTO chats(id,title,url) VALUES(${item.id}::uuid,${item.title},${new URL(`/g/${resolved.id}/c/${item.id}`,cfg.chatgpt.url).toString()})
                ON CONFLICT(id) DO UPDATE SET title=CASE WHEN EXCLUDED.title<>'' THEN EXCLUDED.title ELSE chats.title END`;
              await recordChatBrowser(sql,item.id,runtime.name);
              await sql`INSERT INTO chatgpt_watcher_project_scans(browser_name,project_id,chat_id,project_order,updated_at)
                VALUES(${runtime.name},${resolved.id},${item.id}::uuid,${item.order},NOW())
                ON CONFLICT(browser_name,project_id,chat_id) DO UPDATE SET project_order=EXCLUDED.project_order,updated_at=NOW()`;
            }
            const pending = await sql`SELECT chat_id::text AS id,project_order AS "order",scanned_at
              FROM chatgpt_watcher_project_scans WHERE browser_name=${runtime.name} AND project_id=${resolved.id}
              ORDER BY project_order ASC`;
            return Response.json({ok:true,browser_name:runtime.name,project_id:resolved.id,
              chats:pending.filter(r=>chats.some(c=>c.id===r.id)).map(r=>({id:r.id,title:chats.find(c=>c.id===r.id)?.title || r.id,order:r.order,scanned:Boolean(r.scanned_at)}))});
          } finally { pagesReadingAttachmentHistory.delete(listingPage); await listingPage.close().catch(()=>{}); }
        }
        if (url.pathname === "/rescan") {
          const requestedId = body.chat_id ? normalizeUuid(body.chat_id) : null;
          if (body.chat_id && !requestedId) return Response.json({error: 'invalid chat_id'}, {status: 400});
          const existing = requestedId
            ? openConversationPages(runtimes).find(item => item.chatId === requestedId && (!body.browser_name || item.runtime.name===body.browser_name))
            : (() => { try { return getVirtualFocus(focus, runtimes); } catch { return undefined; } })();
          const chatId = requestedId ?? existing?.chatId;
          if (!chatId) return Response.json({error:'no chat selected or under virtual focus'}, {status:404});
          // Guard by chat, not just by page: a poll already in flight, or the
          // first poll after traversal, must never apply historical archives.
          rescanHookQuarantine.set(chatId, new Set());
          const selectedRuntime = body.browser_name ? runtimes.find(r=>r.name===body.browser_name) : undefined;
          if (body.browser_name && !selectedRuntime) throw new Error(`browser '${body.browser_name}' not running`);
          const runtime = existing?.runtime ?? selectedRuntime ?? await ensureRuntimeForChat(chatId);
          const temporary = !existing;
          const page = existing?.page ?? await runtime.context.newPage();
          try {
            if (temporary) {
              configurePage(page,cfg);
              await page.goto(new URL(body.project_id ? `/g/${body.project_id}/c/${chatId}` : `/c/${chatId}`, cfg.chatgpt.url).toString(), {
                waitUntil:'domcontentloaded', timeout:cfg.browser?.navigation_timeout_ms ?? 45_000
              });
              // Suppress hooks before any historical navigation.
              pagesReadingAttachmentHistory.add(page);
              await waitForConversationReady(page,chatId,cfg.browser?.navigation_timeout_ms ?? 45_000);
            }
            const stats = await rescanChatHistory(sql,page,chatId,runtime.name);
            // A manual `ctl rescan` also completes any existing project scan
            // inventory entries for this chat, even when the chat is opened at
            // the ordinary /c/ URL with no project breadcrumb.
            await sql`UPDATE chatgpt_watcher_project_scans SET scanned_at=NOW(),last_error=NULL,updated_at=NOW()
              WHERE browser_name=${runtime.name} AND chat_id=${chatId}::uuid`;
            const projectId = body.project_id || projectFromUrl(page.url()) || await projectForBrowser(sql,runtime.name);
            if (projectId && projectSlugPattern.test(projectId)) {
              await sql`INSERT INTO chatgpt_watcher_project_scans(browser_name,project_id,chat_id,project_order,scanned_at,last_error,updated_at)
                VALUES(${runtime.name},${projectId},${chatId}::uuid,${Number.isInteger(body.project_order)?body.project_order:2147483647},NOW(),NULL,NOW())
                ON CONFLICT(browser_name,project_id,chat_id) DO UPDATE SET scanned_at=NOW(),last_error=NULL,updated_at=NOW()`;
            }
            return Response.json({ok:true,chat_id:chatId,...stats});
          } catch (error) {
            if (body.project_id && projectSlugPattern.test(body.project_id)) {
              await sql`UPDATE chatgpt_watcher_project_scans SET last_error=${String(error).slice(0,2000)},updated_at=NOW()
                WHERE browser_name=${runtime.name} AND project_id=${body.project_id} AND chat_id=${chatId}::uuid`.catch(()=>{});
            }
            throw error;
          } finally {
            if (temporary) { pagesReadingAttachmentHistory.delete(page); await page.close().catch(() => {}); }
          }
        }
        if (url.pathname === "/html") {
          const requestedId = body.chat_id ? normalizeUuid(body.chat_id) : null;
          if (body.chat_id && !requestedId) return Response.json({ error: "invalid chat_id" }, { status: 400 });
          // Snapshot only an existing page; do not open, focus, navigate or scroll.
          const target = requestedId
            ? openConversationPages(runtimes).find((item) => item.chatId === requestedId)
            : (() => { try { return getVirtualFocus(focus, runtimes); } catch { return undefined; } })();
          if (!target || target.page.isClosed()) {
            return Response.json({ error: requestedId
              ? `chat ${requestedId} is not currently open; use ctl open first`
              : "no virtually focused open chat; use ctl open first" }, { status: 404 });
          }
          const html = await target.page.content();
          log.info(`[ctl] html snapshot chat=${normalizeUuid(target.page.url()) ?? "unknown"} browser=${target.runtime.name} bytes=${Buffer.byteLength(html)}`);
          return Response.json({ ok: true, chat_id: normalizeUuid(target.page.url()), browser_name: target.runtime.name, html });
        }
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
        if (url.pathname === "/jump-message") {
          const chatId = normalizeUuid(body.chat_id || "");
          const messageId = normalizeUuid(body.message_id || "");
          if (!chatId || !messageId) return Response.json({ error: "valid chat_id and message_id required" }, { status: 400 });
          const existing = openConversationPages(runtimes).find((item) => item.chatId === chatId);
          const runtime = existing?.runtime ?? await ensureRuntimeForChat(chatId);
          const page = existing?.page ?? await makePage(runtime);
          if (!existing) {
            await page.goto(new URL(`/c/${chatId}`, cfg.chatgpt.url).toString(), {
              waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000,
            });
            await waitForConversationReady(page, chatId, cfg.browser?.navigation_timeout_ms ?? 45_000);
            await recordChatBrowser(sql, chatId, runtime.name);
          }
          // Navigating historical messages is never a new ZIP event.
          pagesReadingAttachmentHistory.add(page);
          try {
            const jump = async () => page.evaluate((id: string) => {
              const candidates = Array.from(document.querySelectorAll<HTMLElement>(
                '[data-chatgpt-search-message-ids], [data-dil-message-id], [data-content-search-unit-key]'));
              const target = candidates.find(el => {
                const ids = [el.getAttribute('data-chatgpt-search-message-ids') || '',
                  el.getAttribute('data-dil-message-id') || '',
                  el.getAttribute('data-content-search-unit-key') || ''].join(' ');
                return ids.toLowerCase().includes(id);
              });
              if (!target) return false;
              target.scrollIntoView({ block: 'center', behavior: 'instant' });
              return true;
            }, messageId);
            let found = await jump();
            let stagnant = 0;
            for (let step = 0; !found && step < 160; step++) {
              const move = await scrollChatHistoryUp(page);
              await page.waitForTimeout(180);
              found = await jump();
              stagnant = move.moved ? 0 : stagnant + 1;
              if (move.top && stagnant >= 4) break;
            }
            if (!found) return Response.json({ error: `message ${messageId} not found in loaded history`, chat_id: chatId }, { status: 404 });
            setVirtualFocus(focus, runtime, page, "ctl");
            await page.bringToFront();
            log.info(`[ctl] jump chat=${chatId} message=${messageId}`);
            return Response.json({ ok: true, chat_id: chatId, message_id: messageId });
          } finally {
            pagesReadingAttachmentHistory.delete(page);
          }
        }
        if (url.pathname === "/open") {
          const openStartedAt = performance.now();
          const chatId = normalizeUuid(body.chat_id || "");
          if (!chatId) return Response.json({ error: "invalid chat_id" }, { status: 400 });
          const existing = openConversationPages(runtimes).find((item) => item.chatId === chatId);
          const runtime = existing?.runtime ?? await ensureRuntimeForChat(chatId);
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
              // Closing the last pane must not resurrect a manually closed browser.
              focus.page = undefined;
              focus.runtime = undefined;
            }
          }
          return Response.json({ ok: true, closed_chat_id: closedId, browser_name: target.runtime.name, chat_ids: openConversationPages(runtimes).map((item) => item.chatId) });
        }
        if (url.pathname === "/new-chat") {
          const runtime = focus.runtime && runtimes.includes(focus.runtime) ? focus.runtime : chooseDefaultRuntime();
          if (!runtime) return Response.json({ error: "no browser open; use ctl open <chat> or ctl send --chat <chat> first" }, { status: 409 });
          const page = await makePage(runtime);
          const target = await newChatTarget(runtime);
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
          const sendExisting = Boolean(body.send_existing);
          if (!text.trim() && files.length === 0 && !sendExisting) return Response.json({ error: "text or at least one file is required" }, { status: 400 });
          if (sendExisting && (draft || body.new_chat || text.trim() || files.length)) return Response.json({ error: "send_existing must submit only the current composer" }, { status: 400 });
          if (draft && body.new_chat) return Response.json({ error: "--draft cannot be combined with --new-chat; open a blank chat first" }, { status: 400 });
          for (const file of files) await access(file, constants.R_OK);
        const requestedChatId = normalizeUuid(body.chat_id || "");
          let runtime: BrowserRuntime;
          let page: Page;
          if (requestedChatId) {
            runtime = await ensureRuntimeForChat(requestedChatId);
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
              await page.goto(await newChatTarget(runtime), {
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
          // Select the destination as soon as the send request starts, not after
          // the potentially slow composer/upload operation. Browser activation
          // is dispatched asynchronously and must not delay sending.
          setVirtualFocus(focus, runtime, page, "ctl");
          void page.bringToFront().catch((error) => {
            log.warn(`[ctl] asynchronous send pane activation failed chat=${requestedChatId || normalizeUuid(page.url()) || "new"}: ${String(error)}`);
          });
          if (sendExisting) {
            const activeComposer = page.locator('#prompt-textarea:visible, [data-composer-markdown][contenteditable="true"]:visible, [contenteditable="true"][role="textbox"]:visible, textarea:visible').last();
            await activeComposer.waitFor({ state: "visible", timeout: 20_000 });
            const form = activeComposer.locator('xpath=ancestor::form[1]');
            const send = form.locator('button[data-testid="send-button"], button[aria-label="Send message" i], button[aria-label="Send" i], button[data-composer-navigation-target="send"]').filter({ visible: true }).last();
            if (!await send.count() || !await send.isEnabled()) throw new Error("send: current composer has no enabled Send button or is still uploading");
            log.info(`[send] submitting existing composer chat=${requestedChatId || normalizeUuid(page.url()) || 'focused'}`);
          }
          await sendInPage(page, text, undefined, files, !draft);
          if (body.new_chat) {
            await page.waitForFunction(() =>
              /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(location.pathname),
              null,
              { timeout: 45_000 },
            );
          }
          // Already focused and activation scheduled before the send.
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

          if (url.pathname === "/files/download") {
          const chatId = normalizeUuid(body.chat_id || "");
          const identity = typeof (body as { identity?: unknown }).identity === "string"
            ? (body as { identity: string }).identity : "";
          if (!chatId || !identity || !body.directory) return Response.json({ error: "chat_id, identity and directory are required" }, { status: 400 });
          const existing = openConversationPages(runtimes).find((item) => item.chatId === chatId);
          const runtime = existing?.runtime ?? await ensureRuntimeForChat(chatId);
          // A temporary page must not steal virtual focus or stay open afterwards.
          const temporary = !existing;
          const targetPage = existing?.page ?? await runtime.context.newPage();
          try {
            if (temporary) {
              configurePage(targetPage, cfg);
              const target = new URL(`/c/${chatId}`, cfg.chatgpt.url).toString();
              await targetPage.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
              await waitForConversationReady(targetPage, chatId, cfg.browser?.navigation_timeout_ms ?? 45_000);
            }
            const current = await scrapeCurrentChat(targetPage);
            if (current?.id === chatId) {
              await upsertChat(sql, current, runtime.name);
              await indexChatFiles(sql, targetPage, current);
            }
            const saved = await downloadChatFile(targetPage, chatId, identity, path.resolve(body.directory));
            return Response.json({ ok: true, chat_id: chatId, path: saved });
          } finally {
            if (temporary) await targetPage.close().catch(() => {});
          }
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
        const runtime = requestedChatId ? await ensureRuntimeForChat(requestedChatId) : virtualTarget!.runtime;
        let page = requestedChatId
          ? openConversationPages([runtime]).find((item) => item.chatId === requestedChatId)?.page
          : virtualTarget!.page;
        if ((url.pathname === "/hook/run" || url.pathname === "/download-last-zip") && requestedChatId && !page) {
          page = await makePage(runtime);
          if (url.pathname === "/hook/run") {
            // Focus immediately, independently of the potentially slow navigation
            // and build. Do not await the window manager before starting work.
            setVirtualFocus(focus, runtime, page, "ctl");
            void page.bringToFront().catch((error) => log.warn(`[hook] focus failed: ${formatError(error)}`));
          }
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
          // An explicit hook run selects the chat as soon as it is targeted,
          // before ZIP download or compilation. The focus request is deliberately
          // fire-and-forget so it cannot delay the command pipeline.
          if (requestedChatId) {
            setVirtualFocus(focus, runtime, page, "ctl");
            void page.bringToFront().catch((error) => log.warn(`[hook] focus failed: ${formatError(error)}`));
          }
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
          const saved = await downloadLastZip(page, directory);
          if (!saved) throw new Error("no assistant ZIP is available for download");
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

async function ensureChatLinkSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS chatgpt_watcher_chat_links (
    previous_chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    next_chat_id uuid NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
    draft_ready boolean NOT NULL DEFAULT true,
    archive_created boolean NOT NULL DEFAULT false,
    archive_path text,
    last_error text,
    linked_at timestamptz NOT NULL DEFAULT now(),
    CHECK (previous_chat_id <> next_chat_id)
  )`);
}

/** Only examine visible application controls, never message bodies. A quoted
 * 'conversation too long' inside chat content must not start a new chat. */
async function hasConversationLengthLimit(page: Page): Promise<boolean> {
  return page.evaluate((patternSource) => {
    const phrase = new RegExp(patternSource, "i");
    const candidates = document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [data-testid*="conversation-limit"], [data-testid*="chat-limit"], [data-testid*="max-length"], [data-testid*="conversation-too-long"], [data-testid*="composer-error"], form [class*="error"], [data-testid="conversation-turn-limit"], main [class*="notice"], main [class*="warning"], form button, footer');
    for (const element of candidates) {
      if (element.closest('[data-message-author-role], article[data-testid*="conversation-turn"]')) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden") continue;
      if (phrase.test((element.textContent || "").slice(0, 800))) return true;
    }
    // Some versions render a non-alert banner next to the composer. Limit
    // traversal to its nearby wrappers: full chat DOM traversal each poll can
    // freeze very long conversations (the exact problem we're fixing).
    const composer = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], textarea[placeholder]');
    let wrapper = composer?.parentElement;
    for (let depth = 0; depth < 6 && wrapper; depth++, wrapper = wrapper.parentElement) {
      const leaves = wrapper.querySelectorAll('span, p, button');
      if (leaves.length > 180) break;
      for (const node of leaves) {
        if (node.children.length || node.closest('[data-message-author-role], article[data-testid*="conversation-turn"]')) continue;
        const label = (node.textContent || '').trim();
        if (label.length < 12 || label.length > 230 || !phrase.test(label)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width && rect.height && getComputedStyle(node).visibility !== 'hidden') return true;
      }
    }
    // ChatGPT can show the limit as a disabled composer placeholder.
    if (composer) {
      const placeholder = composer.getAttribute('placeholder') || composer.getAttribute('data-placeholder') || '';
      if (phrase.test(placeholder)) return true;
    }
    return false;
  }, conversationLengthLimitPattern.source);
}

async function watch(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
  await ensureHookSchema(sql);
  await ensureChatLinkSchema(sql);
  await ensureRetrySchema(sql);
  await ensureBrowserSchema(sql);
  await ensureChatFilesSchema(sql);
  const pollMs = Math.max(500, cfg.chatgpt.poll_ms ?? 1500);
  const settleMs = cfg.chatgpt.complete_settle_ms ?? 800;
  const profiles = await discoverBrowserProfiles(cfg, configPath);
  const runtimes: BrowserRuntime[] = [];
  const focus: VirtualFocus = { at: 0, source: "manual", pageFocusAt: new WeakMap<Page, number>(), restoring: true };
  try {
    for (const profile of profiles) {
      const allowed = await browserStartupEnabled(sql, profile.name);
      await registerBrowser(sql, profile);
      if (!allowed) {
        log.info(`[watch] browser=${profile.name} stays closed (manual close persisted)`);
        continue;
      }
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
  const activeRollovers = new Set<string>();
  const rolloverRetryAt = new Map<string, number>();
  const rolloverChats = async (runtime: BrowserRuntime, old: ScrapedChat, hook: ChatHook) => {
    if (activeRollovers.has(old.id) || Date.now() < (rolloverRetryAt.get(old.id) || 0)) return;
    activeRollovers.add(old.id);
    let successor: Page | undefined;
    try {
      const existing = await sql`SELECT next_chat_id::text AS next_id, draft_ready, archive_path, archive_created
        FROM chatgpt_watcher_chat_links WHERE previous_chat_id=${old.id}::uuid`;
      if (existing.length && existing[0]!.draft_ready) return;
      const base = path.basename(path.resolve(resolveFromConfig(configPath, hook.folder)));
      const expectedZip = path.join(os.homedir(), "zips", `${base}.zip`);
      let nextId: string | null = existing.length ? String(existing[0]!.next_id) : null;
      let archive = existing.length ? String(existing[0]!.archive_path || expectedZip) : expectedZip;
      let archiveCreated = Boolean(existing[0]?.archive_created);
      if (!nextId) {
        // Create the actual successor first, then run wcz asynchronously.
        // ChatGPT cannot provide a UUID for a blank chat before its first send.
        const projectRows = await sql`SELECT project_id FROM chatgpt_watcher_project_scans
          WHERE chat_id=${old.id}::uuid AND browser_name=${runtime.name}
          ORDER BY updated_at DESC LIMIT 1`;
        const project = projectRows[0]?.project_id || await projectForBrowser(sql, runtime.name);
        const target = new URL(project ? `/g/${project}/project` : "/", cfg.chatgpt.url).toString();
        successor = await runtime.context.newPage();
        configurePage(successor, cfg);
        attachNetworkDebug(successor, cfg);
        await successor.goto(target, {waitUntil:"domcontentloaded", timeout:cfg.browser?.navigation_timeout_ms ?? 45000});
        await successor.locator('#prompt-textarea:visible, [data-composer-markdown][contenteditable="true"]:visible, [contenteditable="true"][role="textbox"]:visible, textarea:visible').last()
          .waitFor({state:"visible",timeout:30000});
        // A blank ChatGPT tab has NO conversation ID. Create a real first turn,
        // then capture its stable UUID before copying hooks or linking.
        try {
          await sendInPage(successor,
            `Continuing the previous conversation: ${new URL(`/c/${old.id}`, cfg.chatgpt.url)}. The original chat reached its length limit. An updated project ZIP will be attached as a draft for the next request.`,
            undefined, [], true);
        } catch (error) {
          // ChatGPT can update the route before our lightweight acknowledgement
          // sees the new user bubble. An actual new UUID is stronger evidence
          // than a timeout; recover it instead of creating another chat.
          await successor.waitForFunction(() => /\/c\/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(location.pathname),
            null, {timeout:7000}).catch(() => undefined);
          if (!normalizeUuid(successor.url()) || normalizeUuid(successor.url()) === old.id) throw error;
          log.warn(`[rollover] initial send acknowledgement uncertain but new URL exists: ${successor.url()}`);
        }
        await successor.waitForFunction(() => /\/c\/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(location.pathname), null, {timeout:45000});
        nextId = normalizeUuid(successor.url());
        if (!nextId || nextId === old.id) throw new Error('successor chat has no distinct UUID after initial message');
        // Do not scrape the entire just-created conversation while it is
        // streaming. Persist the known UUID immediately to avoid orphaning it.
        await upsertChat(sql, {id:nextId, title:`Continuation of ${old.title}`,
          url:successor.url(), messages:[], isStreaming:false}, runtime.name);
        await sql.begin(async tx => {
          await tx`INSERT INTO chatgpt_watcher_chat_links (previous_chat_id,next_chat_id,draft_ready,archive_path)
            VALUES (${old.id}::uuid,${nextId!}::uuid,false,${archive})`;
          await tx`INSERT INTO chat_hooks (chat_id, folder, child_folder, nix_flake, clipboard_command, build_command, stages, enabled)
            SELECT ${nextId!}::uuid, folder, child_folder, nix_flake, clipboard_command, build_command, stages, enabled
            FROM chat_hooks WHERE chat_id=${old.id}::uuid ON CONFLICT (chat_id) DO NOTHING`;
        });
        await recordChatBrowser(sql, nextId, runtime.name);
        log.info(`[rollover] linked previous=${old.id} next=${nextId} archive=${archive}`);
      } else {
        successor = openConversationPages([runtime]).find(p => p.chatId===nextId)?.page;
        if (!successor) {
          successor = await runtime.context.newPage();
          configurePage(successor, cfg);
          attachNetworkDebug(successor, cfg);
          await successor.goto(new URL(`/c/${nextId}`, cfg.chatgpt.url).toString(), {waitUntil:"domcontentloaded"});
        }
      }
      if (!successor) throw new Error('successor browser pane unavailable');
      setVirtualFocus(focus, runtime, successor, "ctl");
      void successor.bringToFront().catch(() => {});
      if (!archiveCreated) {
        const started = Date.now();
        log.info(`[rollover] archiving previous=${old.id} successor=${nextId} cwd=${hook.folder} command='wcz .'`);
        // `wcz` may be a zsh/bash function from the user's interactive config,
        // not an executable on PATH. Use their shell when available.
        const userShell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "sh";
        const shellFlag = /(?:^|\/)(?:zsh|bash|fish)$/.test(userShell) ? "-ic" : "-lc";
        const proc = Bun.spawn([userShell, shellFlag, "wcz ."], {
          cwd: resolveFromConfig(configPath, hook.folder), stdout: "pipe", stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        if (exit !== 0) throw new Error(`wcz . exited ${exit}: ${(stderr || stdout).slice(-1200)}`);
        const info = await stat(expectedZip);
        if (!info.isFile() || info.size < 4 || info.mtimeMs < started - 2500)
          throw new Error(`wcz . did not refresh expected archive ${expectedZip}`);
        archive = expectedZip;
      }
      await access(archive, constants.R_OK);
      const f = await open(archive, "r");
      try {
        const bytes = Buffer.alloc(4);
        await f.read(bytes, 0, 4, 0);
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || ![3, 5, 7].includes(bytes[2]))
          throw new Error(`archive is not a ZIP: ${archive}`);
      } finally { await f.close(); }
      const zipCheck = await commandOutput(["unzip", "-tqq", archive]);
      if (zipCheck.code !== 0) throw new Error(`archive failed integrity check: ${zipCheck.stderr || zipCheck.stdout}`);
      if (!archiveCreated) {
        await sql`UPDATE chatgpt_watcher_chat_links SET archive_created=true,archive_path=${archive},last_error=NULL
          WHERE previous_chat_id=${old.id}::uuid`;
      }
      await successor.locator('button[data-testid="stop-button"]:visible, button[aria-label="Stop generating" i]:visible').first()
        .waitFor({state:"hidden",timeout:90000}).catch(() => undefined);
      // This is the same operation as `ctl send --draft -f ~/zips/<folder>.zip`.
      // Do not submit the ZIP and do not trigger the successor hook.
      const alreadyDrafted = await successor.evaluate((name) => {
        const composer = document.querySelector('form:has(#prompt-textarea), form:has([data-composer-markdown])');
        if (!composer) return false;
        return Array.from(composer.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], [title]'))
          .some(el => (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').includes(name));
      }, path.basename(archive));
      if (!alreadyDrafted) await sendInPage(successor, "", undefined, [archive], false);
      await sql`UPDATE chatgpt_watcher_chat_links SET draft_ready=true,last_error=NULL
        WHERE previous_chat_id=${old.id}::uuid`;
      log.info(`[rollover] COMPLETE previous=${old.id} next=${nextId} draft=${archive}`);
    } catch (err) {
      rolloverRetryAt.set(old.id, Date.now()+60_000);
      await sql`UPDATE chatgpt_watcher_chat_links SET last_error=${String(err).slice(0,2000)}
        WHERE previous_chat_id=${old.id}::uuid`.catch(()=>{});
      log.error(`[rollover] chat=${old.id} failed (retry in 60s): ${formatError(err)}`);
      // Don't close a successor with an unsent draft; it may be recoverable.
    } finally { activeRollovers.delete(old.id); }
  };
  const handledHookDownloads = new Set<string>();
  // An automatic ZIP may become downloadable minutes after its link appears.
  // Keep first-seen eligibility across polls; never blacklist a transient failure.
  const pendingZipDownloads = new Map<string, { attempts: number; firstAt: number; nextAt: number }>();
  const initializedHookChats = new Set<string>();
  // Newly completed assistant message ids are retained briefly because the
  // downloadable ZIP control can render a poll or two after its message.
  const pendingHookMessages = new Map<string, Map<string, number>>();
  // Multiple open panes can show the same conversation. Never run its hook twice concurrently.
  const activeHookChats = new Set<string>();
  const retryClickCooldowns = new Map<string, number>();
  const deliveryRetryState = new Map<string, { attempts: number; lastAttempt: number; absentPolls: number }>();
  const closedContexts = new WeakSet<BrowserContext>();
  const manualVerificationContexts = new WeakSet<BrowserContext>();
  const manualVerificationBrowsers = new Set<string>();
  let stopping = false;
  const attachBrowserClose = (runtime: BrowserRuntime) => {
    runtime.context.on("close", () => {
      closedContexts.add(runtime.context);
      runtime.activePage = undefined;
      if (stopping || manualVerificationContexts.has(runtime.context)) return;
      // Remove the runtime from the active set: /status and ctl chats must
      // immediately reflect only live browser panes.
      const index = runtimes.indexOf(runtime);
      if (index >= 0) runtimes.splice(index, 1);
      if (focus.runtime === runtime) {
        focus.runtime = undefined;
        focus.page = undefined;
      }
      void setBrowserStartupEnabled(sql, runtime.name, false).catch((err) =>
        log.error(`[watch] cannot persist browser closure ${runtime.name}: ${formatError(err)}`));
      sessionPersistence.schedule("browser-closed");
      log.info(`[watch] browser=${runtime.name} closed by user; will remain closed on restart`);
    });
  };
  for (const runtime of runtimes) attachBrowserClose(runtime);

  /** Hand control to a non-automated Chromium using the exact same profile. */
  const resolveCaptchaManually = async (runtime: BrowserRuntime, reason: string): Promise<void> => {
    if (stopping || manualVerificationBrowsers.has(runtime.name)) return;
    manualVerificationBrowsers.add(runtime.name);
    const originalContext = runtime.context;
    const originalPages = originalContext.pages().filter((page) => !page.isClosed());
    const originalUrls = originalPages.map((page) => page.url())
      .filter((url) => /^https?:\/\//.test(url));
    const focusedUrl = focus.runtime === runtime ? focus.page?.url() : undefined;
    const targetUrl = originalUrls.find((url) => normalizeUuid(url)) ??
      originalUrls.find((url) => url.startsWith(new URL(cfg.chatgpt.url).origin)) ?? cfg.chatgpt.url;
    log.warn(`[captcha] detected browser=${runtime.name} reason=${reason}; pausing automated browsing`);
    try {
      // This flush occurs while tabs are still alive, preserving chat order and
      // virtual focus across the automation/manual-browser boundary.
      sessionPersistence.schedule('captcha-handoff');
      await sessionPersistence.flush();
      manualVerificationContexts.add(originalContext);
      // Browser profile locks require the automated process to exit first.
      await originalContext.close();
      log.warn(`[captcha] browser=${runtime.name} closed automation; opening NORMAL Chromium for manual verification`);
      log.warn(`[captcha] resolve the challenge, then CLOSE the normal browser window to resume the watcher`);
      await login(cfg, configPath, runtime.name, targetUrl);
      if (stopping) return;
      const replacement = await launchContext(cfg, configPath, cfg.browser?.headless ?? false, runtime.name);
      runtime.context = replacement;
      runtime.activePage = undefined;
      attachBrowserClose(runtime);
      await installFocusTracking(runtime, focus, cfg);
      const tabs = replacement.pages().filter((page) => !page.isClosed());
      const desired = originalUrls.length ? originalUrls : [targetUrl];
      // Rebuild each previous tab in order without creating duplicate blank tabs.
      for (let i = 0; i < desired.length; i++) {
        const tab = tabs[i] ?? await replacement.newPage();
        configurePage(tab, cfg);
        await tab.goto(desired[i]!, { waitUntil: 'domcontentloaded', timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
        attachNetworkDebug(tab, cfg);
        if (desired[i] === focusedUrl || (!runtime.activePage && desired[i] === targetUrl)) {
          runtime.activePage = tab;
        }
      }
      runtime.activePage ??= replacement.pages().find((page) => !page.isClosed());
      if (runtime.activePage && focusedUrl) setVirtualFocus(focus, runtime, runtime.activePage, 'ctl');
      await setBrowserStartupEnabled(sql, runtime.name, true);
      sessionPersistence.schedule('captcha-resumed');
      log.info(`[captcha] resumed browser=${runtime.name} tabs=${desired.length} after manual verification`);
    } catch (error) {
      log.error(`[captcha] manual verification failed for browser=${runtime.name}: ${formatError(error)}`);
      // An unattended retry must never launch a second automated browser on
      // the locked/broken profile. Leave this browser paused for explicit retry.
      const i = runtimes.indexOf(runtime);
      if (i >= 0) runtimes.splice(i, 1);
      if (focus.runtime === runtime) { focus.runtime = undefined; focus.page = undefined; }
      await setBrowserStartupEnabled(sql, runtime.name, false).catch(() => undefined);
    } finally {
      manualVerificationBrowsers.delete(runtime.name);
    }
  };

  // Explicit ctl open/send may revive a closed profile, but ordinary scans
  // and watcher startup will never do so.
  const openingRuntimes = new Map<string, Promise<BrowserRuntime>>();
  const ensureRuntimeForChat = async (chatId: string): Promise<BrowserRuntime> => {
    const existing = openConversationPages(runtimes).find((item) => item.chatId === chatId);
    if (existing) return existing.runtime;
    const preferredName = await browserNameForChat(sql, chatId) ?? "default";
    const profile = profiles.find((item) => item.name === preferredName)
      ?? profiles.find((item) => item.name === "default") ?? profiles[0];
    if (!profile) throw new Error("no browser profile is configured");
    const active = runtimes.find((item) => item.name === profile.name);
    if (active) return active;
    const inFlight = openingRuntimes.get(profile.name);
    if (inFlight) return inFlight;
    const opening = (async () => {
      const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false, profile.name);
      const runtime: BrowserRuntime = { ...profile, context, lastFocusAt: 0 };
      runtimes.push(runtime);
      attachBrowserClose(runtime);
      try {
        runtime.activePage = await getPage(context);
        await installFocusTracking(runtime, focus, cfg);
        attachNetworkDebug(runtime.activePage, cfg);
        await setBrowserStartupEnabled(sql, profile.name, true);
        sessionPersistence.schedule("ctl-browser-reopened");
        log.info(`[watch] reopened browser=${profile.name} for chat=${chatId}`);
        return runtime;
      } catch (err) {
        await context.close().catch(() => undefined);
        throw err;
      }
    })();
    openingRuntimes.set(profile.name, opening);
    try { return await opening; }
    finally { openingRuntimes.delete(profile.name); }
  };

  const isClosedTargetError = (error: unknown) =>
    /(?:target page, context or browser has been closed|browser has been closed|target closed|context closed|page closed)/i.test(formatError(error));

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
      await installFocusTracking(runtime, focus, cfg);
      attachNetworkDebug(runtime.activePage, cfg);
    }

    const restoredCount = await restoreOpenChatSession(sql, runtimes, focus, cfg);
    let initialTotal = 0;
    for (const runtime of runtimes) {
      if (!runtime.activePage || runtime.activePage.isClosed()) {
        runtime.activePage = await getPage(runtime.context);
      }
      const initialPages = runtime.context.pages().filter((page) => !page.isClosed());
      let verification: string | null = null;
      for (const candidate of initialPages) {
        verification = await activeBrowserChallenge(candidate);
        if (verification) break;
      }
      if (!verification) await ensureCurrentChatGPTPage(runtime.activePage, cfg);
      if (verification) {
        await resolveCaptchaManually(runtime, verification);
        if (!runtime.activePage) continue;
      }
      const sidebarChats = await syncSidebarChats(runtime.activePage, sql, true, runtime.name);
      initialTotal += sidebarChats.length;
      log.info(`[watch] browser=${runtime.name} synchronized ${sidebarChats.length} sidebar chats`);
    }
    const initialFocus = runtimes.find((runtime) => runtime.name === "default") ?? runtimes[0];
    if (!focus.page && initialFocus?.activePage) setVirtualFocus(focus, initialFocus, initialFocus.activePage, "ctl");
    // Until this point, navigation and browser startup focus events are ignored.
    // The saved target is authoritative even when another pane opened last.
    focus.restoring = false;
    // Startup restore is complete: commit the authoritative post-restore
    // snapshot now, then keep it current from browser page/focus events.
    sessionPersistence.resume();
    sessionPersistence.schedule("watch-startup");
    await sessionPersistence.flush();
    log.info(`[watch] restored ${restoredCount} previously open chat pane(s)`);
    controlServer = startControlServer(runtimes, focus, cfg, configPath, sql, ensureRuntimeForChat);
    log.info(`[watch] synchronized ${initialTotal} sidebar chats across ${runtimes.length} browser profile(s)`);
    log.info(`[watch] poll=${pollMs}ms settle=${settleMs}ms multi-pane and multi-browser enabled`);

    while (true) {
      try {
        const entries: Array<{ runtime: BrowserRuntime; page: Page }> = [];
        for (const runtime of runtimes) {
          if (closedContexts.has(runtime.context)) continue;
          let pages: Page[];
          try {
            pages = runtime.context.pages().filter((page) => !page.isClosed());
            // A user closing all tabs must not cause the watcher to reopen one.
            if (!pages.length) {
              runtime.activePage = undefined;
              continue;
            }
            if (!runtime.activePage || runtime.activePage.isClosed() || !pages.includes(runtime.activePage)) {
              runtime.activePage = pages[0];
            }
            // Test every live tab (the challenge may be in a background chat).
            let verification: string | null = null;
            for (const page of pages) {
              verification = await activeBrowserChallenge(page);
              if (verification) break;
            }
            if (verification) {
              await resolveCaptchaManually(runtime, verification);
              continue; // Next poll uses the restored browser/tab objects.
            }
            if (runtime.activePage) {
              await syncSidebarChats(runtime.activePage, sql, false, runtime.name);
            }
            // Prevent extra panes for the same conversation from accumulating.
            // Do not touch tabs belonging to an in-progress ZIP hook: parallel
            // download probes may temporarily navigate to that same chat.
            const uniqueChats = new Map<string, Page>();
            for (const page of pages) {
              const chatId = normalizeUuid(page.url());
              if (!chatId || activeHookChats.has(chatId)) {
                entries.push({ runtime, page });
                continue;
              }
              const previous = uniqueChats.get(chatId);
              if (!previous) {
                uniqueChats.set(chatId, page);
                entries.push({ runtime, page });
                continue;
              }
              const keep = focus.page === page ? page : previous;
              const duplicate = keep === page ? previous : page;
              uniqueChats.set(chatId, keep);
              if (keep === page) {
                const index = entries.findIndex((entry) => entry.page === previous);
                if (index >= 0) entries[index] = { runtime, page };
              }
              log.warn(`[watch] closing duplicate pane browser=${runtime.name} chat=${chatId}`);
              await duplicate.close().catch((error) => {
                if (!isClosedTargetError(error)) log.warn(`[watch] duplicate pane close failed: ${formatError(error)}`);
              });
              sessionPersistence.schedule("duplicate-pane-closed");
            }
          } catch (error) {
            if (closedContexts.has(runtime.context) || isClosedTargetError(error)) {
              closedContexts.add(runtime.context);
              runtime.activePage = undefined;
              continue;
            }
            throw error;
          }
        }
        if (!entries.length) {
          // Keep the control server alive to accept explicit ctl open/send.
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
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
              await indexChatFiles(sql, page, readySnapshot);
              const lastAssistant = [...readySnapshot.messages].reverse().find((message) => message.role === "assistant");
              const lastUser = [...readySnapshot.messages].reverse().find((message) => message.role === "user");
              baselineAssistantTurnByChat.set(chat.id, lastAssistant?.turnOrder ?? null);
              baselineUserTurnByChat.set(chat.id, lastUser?.turnOrder ?? null);
              baselineUserMessageByChat.set(chat.id, lastUser?.id ?? null);
              baselineUserSequenceByChat.set(chat.id, lastUser?.sequence ?? null);
              readyChatByPage.set(page, chat.id);
              lastSeenChatByPage.set(page, chat.id);
              const rolloverHook = await loadChatHook(sql, chat.id);
              if (rolloverHook?.enabled && await hasConversationLengthLimit(page)) {
                void rolloverChats(runtime, chat, rolloverHook);
                return;
              }

              const initialHook = await loadChatHook(sql, chat.id);
              if (initialHook?.enabled) {
                const initialTargets = await findZipTargets(page);
                for (const target of assistantZipTargets(initialTargets, readySnapshot.messages)) handledHookDownloads.add(`${chat.id}:${target.identity}`);
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
            if (hook?.enabled && await hasConversationLengthLimit(page)) {
              // Separate task: polling/persistence remains responsive while wcz
              // and the UI prepare the new conversation. Deduplicated by ID.
              void rolloverChats(runtime, chat, hook);
              return;
            }
            const hookWasInitialized = initializedHookChats.has(chat.id);
            await recordChatBrowser(sql, chat.id, runtime.name);
            // Historical scans own their DB refresh and must not race the
            // regular polling path with partial virtualized message windows.
            if (pagesReadingAttachmentHistory.has(page)) {
              log.debug(`[watch] skipping ordinary persistence/hooks during history read chat=${chat.id}`);
              return;
            }
            // Rescan is a read-only maintenance operation. Its newly mounted
            // old ZIPs must not run hooks once the scroll operation finishes.
            // Do not lift the barrier simply because the visible DOM changes:
            // virtualized history can reveal an older user turn instead.
            const quarantinedUserIds = rescanHookQuarantine.get(chat.id);
            if (quarantinedUserIds) {
              const genuinelyNewUser = quarantinedUserIds.size > 0 && chat.messages.some(
                m => m.role === "user" && !quarantinedUserIds.has(m.id)
              );
              if (!genuinelyNewUser) {
                // Quarantine is normal idle state, not a per-poll diagnostic.
                // Its activation was already logged once by rescanChatHistory.
                return;
              }
              // A genuinely new user request starts the next generation epoch.
              // Rebaseline at the currently visible assistant turn so that an
              // old ZIP is not incorrectly eligible on this transition poll.
              const visibleTargets = await findZipTargets(page);
              for (const target of assistantZipTargets(visibleTargets, chat.messages)) {
                handledHookDownloads.add(`${chat.id}:${target.identity}`);
              }
              baselineAssistantTurnByChat.set(chat.id,
                latestAssistantFromMessages(chat.messages)?.turnOrder ?? null);
              pendingHookMessages.delete(chat.id);
              initializedHookChats.add(chat.id);
              rescanHookQuarantine.delete(chat.id);
              log.info(`[hook] rescan quarantine released on new user turn chat=${chat.id}; ZIP baseline refreshed`);
              return;
            }
            const newAssistantMessages = await persistChat(sql, chat, settleMs, prevIncomplete, runtime.name);
            await indexChatFiles(sql, page, chat);

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
              // File browsing traverses older messages while the polling loop is
              // active. Record what appeared, but never auto-run a hook for it.
              if (pagesReadingAttachmentHistory.has(page)) {
                for (const target of assistantZipTargets(targets, chat.messages)) {
                  handledHookDownloads.add(`${chat.id}:${target.identity}`);
                }
                log.debug(`[hook] suppressed ZIP detection during ctl files history scan chat=${chat.id}`);
                return;
              }
              if (!hookWasInitialized) {
                // Opening/navigating to an existing chat is not a hook event.
                // Establish a baseline before accepting any new message IDs.
                for (const target of assistantZipTargets(targets, chat.messages)) handledHookDownloads.add(`${chat.id}:${target.identity}`);
                initializedHookChats.add(chat.id);
                baselineAssistantTurnByChat.set(chat.id,
                  latestAssistantFromMessages(chat.messages)?.turnOrder ?? null);
                pendingHookMessages.delete(chat.id);
                log.info(`[hook] initialized ZIP baseline for chat=${chat.id} (${targets.length} existing attachments; no hook run)`);
              } else {
                // New attachments are the hook event. They may materialize well
                // after a message is persisted, and another browser pane may
                // receive them while virtual focus belongs to a different pane.
                // The baseline above prevents processing existing attachments
                // merely because a pane was opened or the watcher restarted.
                const observed = assistantZipTargets(targets, chat.messages).sort(newestZipFirst);
                // A scroll mounts previously unseen OLD controls. Their appearance
                // is not a new assistant artifact. Compare stable turn numbers,
                // not volatile DOM positions or database insertion timestamps.
                const baselineTurn = baselineAssistantTurnByChat.get(chat.id) ?? null;
                const fresh = freshZipCandidates(observed, baselineTurn, newAssistantMessages);
                const pendingIds = new Set<string>();
                for (const key of pendingZipDownloads.keys()) {
                  if (key.startsWith(`${chat.id}:`)) pendingIds.add(key.slice(chat.id.length + 1));
                }
                // Retain file eligibility after the numeric assistant-turn baseline
                // advances. Otherwise the first failed click permanently loses it.
                const associated = pendingZipCandidates(observed, fresh, pendingIds);
                for (const historical of observed) {
                  if (!associated.includes(historical)) {
                    handledHookDownloads.add(`${chat.id}:${historical.identity}`);
                  }
                }
                const newestVisibleTurn = chat.messages
                  .filter((message) => message.role === "assistant" && message.turnOrder !== undefined)
                  .reduce<number | null>((max, message) => max === null ? message.turnOrder! : Math.max(max, message.turnOrder!), baselineTurn);
                if (newestVisibleTurn !== null) baselineAssistantTurnByChat.set(chat.id, newestVisibleTurn);
                const archiveDir = path.resolve(resolveFromConfig(configPath, hook.folder), ".chatgpt-ctl-downloads");
                const savedCursor = (await loadSuccessfulZips(archiveDir))[chat.id];
                const unseen = autoZipCandidates(
                  associated,
                  new Set(associated.filter((target) => handledHookDownloads.has(`${chat.id}:${target.identity}`)).map((target) => target.identity)),
                  savedCursor?.targetIdentity
                );
                if (unseen.length && !activeHookChats.has(chat.id) && !rescanHookQuarantine.has(chat.id)) {
                  // Only retry the newest candidate. Older contemporaneous ZIPs
                  // must never be applied just because the newest is unavailable.
                  const newest = unseen[0]!;
                  const hookKey = `${chat.id}:${newest.identity}`;
                  const retry = pendingZipDownloads.get(hookKey);
                  if (retry && Date.now() < retry.nextAt) return;
                  for (const older of unseen.slice(1)) {
                    handledHookDownloads.add(`${chat.id}:${older.identity}`);
                    pendingZipDownloads.delete(`${chat.id}:${older.identity}`);
                  }
                  activeHookChats.add(chat.id);
                  let downloaded = false;
                  try {
                    log.info(`[hook] auto ZIP attempt chat=${chat.id} attempt=${(retry?.attempts ?? 0) + 1} label='${newest.label}' cursor='${savedCursor?.label ?? "none"}'`);
                    // Auto downloads are restricted to THIS new artifact. Never
                    // probe or build a previous release on transient failure.
                    const archive = await downloadLastZip(page, archiveDir, undefined, true, new Set([newest.identity]));
                    if (!archive) throw new Error(`automatic ZIP not downloadable yet: ${newest.label}`);
                    downloaded = true;
                    pendingZipDownloads.delete(hookKey);
                    // Mark after verification, before running the hook. Build
                    // failures should not cause the same source to be reapplied.
                    handledHookDownloads.add(hookKey);
                    const successful = (await loadSuccessfulZips(archiveDir))[chat.id];
                    if (successful?.targetIdentity) handledHookDownloads.add(`${chat.id}:${successful.targetIdentity}`);
                    log.info(`[hook] new ZIP in open pane chat=${chat.id} browser=${runtime.name} (virtual focus unchanged)`);
                    if (rescanHookQuarantine.has(chat.id)) {
                      log.warn(`[hook] discarded auto ZIP after rescan began chat=${chat.id}; refusing historical build`);
                      return;
                    }
                    await runHookForZip(page, chat.id, hook, archive, configPath);
                  } catch (hookError) {
                    if (downloaded) {
                      // A verified archive reached extraction/build; never retry
                      // a failing build automatically.
                      log.error(`[hook] chat=${chat.id} failed: ${formatError(hookError)}`);
                    } else {
                      const next = nextZipAutoRetry(retry, Date.now());
                      if (next.exhausted) {
                        handledHookDownloads.add(hookKey);
                        pendingZipDownloads.delete(hookKey);
                        log.error(`[hook] auto ZIP exhausted after ${next.attempts} attempts chat=${chat.id} file='${newest.label}': ${formatError(hookError)}`);
                      } else {
                        pendingZipDownloads.set(hookKey, next);
                        log.warn(`[hook] auto ZIP not ready chat=${chat.id} attempt=${next.attempts} retry_in_ms=${next.nextAt - Date.now()} file='${newest.label}': ${formatError(hookError)}`);
                      }
                    }
                  } finally {
                    activeHookChats.delete(chat.id);
                  }
                }
              }
            } else {
              initializedHookChats.delete(chat.id);
              pendingHookMessages.delete(chat.id);
            }
          } catch (pageError) {
            if (page.isClosed() || closedContexts.has(runtime.context) || isClosedTargetError(pageError)) return;
            log.error(`[watch] pane scan failed url=${page.url()}: ${formatError(pageError)}`);
          }
        }));
      } catch (error) {
        if (isClosedTargetError(error)) {
          // A window may close between enumerating tabs and scanning them.
          // The next poll will check whether any browser windows remain.
          continue;
        }
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

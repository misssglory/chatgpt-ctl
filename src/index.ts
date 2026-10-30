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
import { access, constants, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

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
  /** true when the UI no longer shows a streaming / "stop generating" state */
  completed: boolean;
}

interface ScrapedChat {
  id: string;
  title: string;
  url: string;
  messages: ScrapedMessage[];
}

interface SidebarChat {
  id: string;
  title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromConfig(configPath: string, rel: string): string {
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(path.dirname(configPath), rel);
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

async function commandOutput(cmd: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
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
  enabled: boolean;
};

async function ensureHookSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chat_hooks (
      chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      folder text NOT NULL,
      child_folder text NOT NULL DEFAULT '.',
      nix_flake boolean NOT NULL DEFAULT false,
      clipboard_command jsonb NOT NULL DEFAULT '["wl-paste", "-n"]'::jsonb,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadChatHook(sql: Sql, chatId: string): Promise<ChatHook | null> {
  const rows = await sql`
    SELECT folder, child_folder, nix_flake, clipboard_command, enabled
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

async function upsertChat(sql: Sql, chat: ScrapedChat): Promise<void> {
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
}

/** Synchronize sidebar metadata without making every chat look newly active. */
async function upsertSidebarChats(sql: Sql, chats: SidebarChat[]): Promise<void> {
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
  }
}

/**
 * Upsert a message. When `completed` flips to true we stamp completed_at.
 * Content is updated on every observation so partial streaming text is refined
 * until the message is marked completed.
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
        WHEN messages.completed = false AND EXCLUDED.completed = true THEN NOW()
        ELSE messages.completed_at
      END
    RETURNING
      (xmax = 0) AS inserted,
      (completed AND completed_at IS NOT NULL AND completed_at > first_seen_at + interval '50 milliseconds') AS just_completed
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
  headless: boolean
): Promise<BrowserContext> {
  const executablePath = await resolveBrowserExecutable(cfg, configPath);
  const profileDir = resolveFromConfig(configPath, cfg.chatgpt.profile_dir);
  await mkdir(profileDir, { recursive: true });

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
      `exe=${executablePath}`
  );

  // Match fomo: pass viewport: null for native-window mode (must be null, not
  // undefined — undefined makes Playwright use the default 1280x720 viewport).
  try {
    return await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless,
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

async function syncSidebarChats(page: Page, sql: Sql, scrollAll = false): Promise<SidebarChat[]> {
  const chats = await scrapeSidebarChats(page, scrollAll);
  await upsertSidebarChats(sql, chats);
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
      const thread = document.querySelector("main") || document.body;
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
    const messageNodes = Array.from(
      document.querySelectorAll("[data-chatgpt-search-message-ids]")
    ).filter((node) => {
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

      const unitKey = node.getAttribute("data-chatgpt-search-unit-key") || "";
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

      messages.push({
        id,
        role,
        content,
        sequence: seq++,
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
    };
  });
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
  const sql = openDb(cfg);
  const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false);
  try {
    const page = await getPage(context);
    attachNetworkDebug(page, cfg);
    await openChatGPT(page, cfg);
    const chats = await syncSidebarChats(page, sql, true);
    if (!quiet) {
      for (const chat of chats) console.log(`${chat.id}\t${chat.title}`);
    }
    log.info(`[chats] synchronized ${chats.length} sidebar chats`);
  } finally {
    await context.close();
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
  const result = await response.json().catch(() => ({})) as { error?: string; url?: string };
  if (!response.ok) {
    throw new Error(result.error || `watch control server returned ${response.status}; start \`bun run watch\` first`);
  }
  console.log(result.url || `opened ${chatId}`);
}

async function sendMessageCommand(
  cfg: Config,
  configPath: string,
  text: string,
  files: string[]
) {
  if (!text.trim() && files.length === 0) {
    throw new Error("send: provide message text or at least one file");
  }
  const resolvedFiles = files.map((file) => path.resolve(file));
  for (const file of resolvedFiles) await access(file, constants.R_OK);

  const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false);
  try {
    const page = await getPage(context);
    attachNetworkDebug(page, cfg);
    await ensureCurrentChatGPTPage(page, cfg);

    const composer = page.locator(
      '#prompt-textarea, [data-composer-markdown][contenteditable="true"], ' +
        '[contenteditable="true"][role="textbox"], textarea'
    ).first();
    await composer.waitFor({ state: "visible" });

    if (resolvedFiles.length > 0) {
      const fileInput = page.locator(
        'input[type="file"][aria-label="Attach files" i], ' +
          'input[type="file"]:not([capture]):not([accept*="image" i]):not([accept*="video" i])'
      ).first();
      if (await fileInput.count()) {
        await fileInput.setInputFiles(resolvedFiles);
      } else {
        throw new Error("send: could not find ChatGPT's file upload input");
      }
      // Let attachment rows initialize; clicking send below still waits for enablement.
      await page.waitForTimeout(1000);
    }

    if (text) await composer.fill(text);
    const sendButton = page.locator(
      'button[data-testid="send-button"], button[aria-label="Send message" i], ' +
        'button[aria-label="Send" i], button[data-composer-navigation-target="send"]'
    ).first();

    try {
      await sendButton.waitFor({ state: "visible", timeout: 5000 });
      await sendButton.click();
    } catch (error) {
      if (!text || (await sendButton.count())) throw error;
      await composer.press("Enter");
    }
    await page.waitForTimeout(1000);
    log.info(
      `[send] submitted text_chars=${text.length} files=${resolvedFiles.length} url=${page.url()}`
    );
  } finally {
    await context.close();
  }
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
  const version = await commandOutput([executablePath, "--version"]);
  log.info(`[doctor] browser --version exit=${version.code} ${version.stdout || version.stderr}`);

  log.info("[doctor] attempting Playwright headless launch...");
  const browser = await chromium.launch({ executablePath, headless: true });
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
async function login(cfg: Config, configPath: string) {
  const executablePath = await resolveBrowserExecutable(cfg, configPath);
  const profileDir = resolveFromConfig(configPath, cfg.chatgpt.profile_dir);
  await mkdir(profileDir, { recursive: true });

  log.info(`[login] browser=${executablePath}`);
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
  log.info("[login] next: bun run dump   or   bun run watch");
}

async function dump(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
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

async function persistChat(sql: Sql, chat: ScrapedChat, settleMs: number, prevIncomplete: Map<string, number>) {
  await upsertChat(sql, chat);
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
    if (status === "inserted" || status === "completed") {
      log.info(
        `[persist] ${status} chat=${chat.id.slice(0, 8)} ${msg.role} ` +
          `seq=${msg.sequence} id=${msg.id.slice(0, 8)}… chars=${msg.content.length}`
      );
    }
  }
}

async function once(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
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

type ZipTarget = { index: number; label: string; selector: string; kind: "link" | "card"; messageOrder: number | null; identity: string };

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
      if (!hasZipExtension && !isDescriptiveZipLink) return;

      const label = [aria, downloadName, title, text].find((value) => /\.zip(?:$|[?#\s])/i.test(value))
        || aria || downloadName || title || text || href;
      // ChatGPT's conversation DOM is not guaranteed to be chronological.
      // DIL attachment nodes can be nested in portals, so inspect all ancestors
      // for either of the conversation search-unit attributes.
      let ancestor: HTMLElement | null = el;
      let messageOrder: number | null = null;
      let messageId = "";
      while (ancestor) {
        if (!messageId) {
          messageId =
            ancestor.getAttribute("data-dil-message-id") ||
            ancestor.getAttribute("data-dil-source-message-id") ||
            ancestor.getAttribute("data-chatgpt-selection-message-id") ||
            "";
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
      result.push({
        index,
        label: cleanLabel,
        selector,
        kind: isLink ? "link" : "card",
        messageOrder,
        identity: `${messageId || `turn-${messageOrder ?? "unknown"}-index-${index}`}|${cleanLabel}`,
      });
    });
    return result;
  });
}

async function waitForDownload(click: () => Promise<unknown>, page: Page): Promise<Download> {
  const downloadPromise = page.waitForEvent("download", { timeout: 12_000 });
  try {
    await click();
    return await downloadPromise;
  } catch (error) {
    // Avoid an unhandled timeout rejection if the click itself failed first.
    void downloadPromise.catch(() => undefined);
    throw error;
  }
}

async function downloadZipTarget(page: Page, targetInfo: ZipTarget, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const targetLocator = page.locator(targetInfo.selector).nth(targetInfo.index);
  let download: Download;
  try {
    download = await waitForDownload(() => targetLocator.click(), page);
  } catch (firstError) {
    // Resource-card buttons open a preview in some ChatGPT builds. In that
    // preview the actual download action is a separate button.
    const downloadButton = page.getByRole("button", { name: /^download(?:\s|$)/i }).last();
    if (!(await downloadButton.isVisible().catch(() => false))) {
      throw new Error(
        `Could not trigger download for '${targetInfo.label}'. ` +
        `ChatGPT may have changed its attachment UI. Initial error: ${String(firstError)}`,
      );
    }
    download = await waitForDownload(() => downloadButton.click(), page);
  }

  const suggested = download.suggestedFilename() || targetInfo.label || "chatgpt-download.zip";
  const filename = safeFilename(suggested);
  const target = path.join(directory, filename);
  await download.saveAs(target);
  log.info(`[download] saved ${target}`);
  return target;
}

async function downloadLastZip(page: Page, directory: string): Promise<string> {
  const targets = await findZipTargets(page);
  if (targets.length === 0) {
    throw new Error(
      "no ZIP attachment found in the current conversation; expected a ChatGPT file link " +
      "(role=link with a .zip name), an attachment card, or an <a href> download link",
    );
  }
  // Log candidates to make UI changes diagnosable. User-uploaded resource
  // cards may not expose a turn key; do not let such an unknown item override
  // assistant attachments whose conversation turns are known.
  log.info(`[download] candidates: ${JSON.stringify(targets.map(({ index, label, messageOrder, kind }) => ({
    index, label, messageOrder, kind,
  })))}`);

  const knownTargets = targets.filter(
    (target) => target.messageOrder !== null,
  );
  const candidates = knownTargets.length > 0 ? knownTargets : targets;
  const newest = candidates.reduce((best, current) => {
    const bestTurn = best.messageOrder;
    const currentTurn = current.messageOrder;
    if (bestTurn !== null && currentTurn !== null) {
      if (currentTurn > bestTurn) return current;
      if (currentTurn < bestTurn) return best;
    }
    return current.index > best.index ? current : best;
  });

  log.info(`[download] selected ${newest.label} (message turn ${newest.messageOrder ?? "unknown"})`);
  return downloadZipTarget(page, newest, directory);
}

async function sendInPage(page: Page, text: string, chatId?: string, files: string[] = []) {
  // This function operates on the watcher's existing page. Do not launch a
  // second browser context: `chatgpt-ctl send` must target the visible chat.
  if (chatId && normalizeUuid(page.url()) !== chatId) {
    await page.goto(new URL(`/c/${chatId}`, "https://chatgpt.com").toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
  }
  const composer = page.locator('#prompt-textarea, [data-composer-markdown][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea').first();
  await composer.waitFor({ state: "visible" });
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
  const sendButton = page.locator('button[data-testid="send-button"], button[aria-label="Send message" i], button[aria-label="Send" i], button[data-composer-navigation-target="send"]').first();
  await sendButton.waitFor({ state: "visible", timeout: 8000 });
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
  const extract = await commandOutput(["unzip", "-o", "-q", archive, "-d", projectDir]);
  if (extract.code !== 0) throw new Error(`ZIP extraction failed: ${extract.stderr}`);

  // Stage only paths supplied by this archive, avoiding unrelated working-tree changes.
  const stagedPaths = entries.map((entry) => path.posix.normalize(entry.replace(/\\/g, "/")));
  const add = await commandOutput(["git", "-C", projectDir, "add", "-A", "--", ...stagedPaths]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const staged = await commandOutput(["git", "-C", projectDir, "diff", "--cached", "--quiet", "--", ...stagedPaths]);
  if (staged.code === 1) {
    const mdPaths = stagedPaths.filter((entry) => entry.toLowerCase().endsWith(".md"));
    const mdDiff = mdPaths.length
      ? await commandOutput(["git", "-C", projectDir, "diff", "--cached", "--", ...mdPaths])
      : { code: 0, stdout: "", stderr: "" };
    const commitMessage = (mdDiff.stdout || "Auto update").slice(0, 18000);
    const commit = await commandOutput(["git", "-C", projectDir, "commit", "--only", "-m", commitMessage, "--", ...stagedPaths]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
    log.info(`[hook] committed ZIP update in ${projectDir}`);
  } else if (staged.code !== 0) {
    throw new Error(`git diff failed: ${staged.stderr}`);
  } else {
    log.info(`[hook] archive produced no Git changes in ${projectDir}`);
  }

  const buildDir = path.resolve(projectDir, hook.child_folder || ".");
  const buildCommand = hook.nix_flake
    ? ["nix", "develop", buildDir, "-c", "wcc", "build"]
    : ["wcc", "build"];
  const build = await commandOutput(buildCommand, buildDir);
  log.info(`[hook] build exit=${build.code}${build.stdout ? ` stdout=${build.stdout.slice(-1000)}` : ""}${build.stderr ? ` stderr=${build.stderr.slice(-1000)}` : ""}`);
  if (build.code !== 0) {
    const clipboardCommand = hook.clipboard_command?.length ? hook.clipboard_command : ["wl-paste", "-n"];
    const clipboard = await commandOutput(clipboardCommand);
    const diagnostic = clipboard.stdout || clipboard.stderr || build.stderr || build.stdout || `wcc build failed with exit code ${build.code}; clipboard was empty`;
    await sendInPage(page, `Build failed (exit code ${build.code}). Latest build output from clipboard:\n\n${diagnostic}`, chatId);
  }
}

function startControlServer(page: Page, cfg: Config, configPath: string) {
  const server = Bun.serve({
    hostname: CONTROL_HOST,
    port: CONTROL_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json({ chat_id: normalizeUuid(page.url()), url: page.url() });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const body = await request.json().catch(() => ({})) as { chat_id?: string; directory?: string; extract_to?: string; text?: string; files?: string[] };
        if (url.pathname === "/open") {
          const chatId = normalizeUuid(body.chat_id || "");
          if (!chatId) return Response.json({ error: "invalid chat_id" }, { status: 400 });
          const target = new URL(`/c/${chatId}`, cfg.chatgpt.url).toString();
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
          return Response.json({ ok: true, chat_id: chatId, url: target });
        }
        if (url.pathname === "/new-chat") {
          // ChatGPT's root route opens the blank composer; unlike /c/<uuid>,
          // it does not bind the browser to an existing conversation.
          const target = new URL("/", cfg.chatgpt.url).toString();
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.browser?.navigation_timeout_ms ?? 45_000 });
          await page.waitForTimeout(1000);
          const finalUrl = page.url();
          if (normalizeUuid(finalUrl)) {
            return Response.json({ error: `ChatGPT redirected away from the new-chat URL: ${finalUrl}`, url: finalUrl }, { status: 409 });
          }
          return Response.json({ ok: true, url: finalUrl });
        }
        if (url.pathname === "/download-last-zip") {
          const directory = body.directory
            ? path.resolve(body.directory)
            : resolveFromConfig(configPath, cfg.downloads?.directory || "./var/downloads");
          const saved = await downloadLastZip(page, directory);
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
            const extracted = await commandOutput(["unzip", "-o", "-q", saved, "-d", extractTo]);
            if (extracted.code !== 0) throw new Error(`ZIP extraction failed: ${extracted.stderr}`);
            log.info(`[download] extracted ${saved} to ${extractTo}`);
            return Response.json({ ok: true, path: saved, extracted_to: extractTo });
          }
          return Response.json({ ok: true, path: saved });
        }
        if (url.pathname === "/send") {
          const chatId = normalizeUuid(body.chat_id || "");
          const text = body.text || "";
          const files = Array.isArray(body.files) ? body.files.map((file) => path.resolve(file)) : [];
          if (!text.trim() && files.length === 0) return Response.json({ error: "text or at least one file is required" }, { status: 400 });
          for (const file of files) await access(file, constants.R_OK);
          await sendInPage(page, text, chatId || undefined, files);
          return Response.json({ ok: true, chat_id: chatId, url: page.url() });
        }
        return new Response("not found", { status: 404 });
      } catch (error) {
        log.error(`[ctl] request failed: ${formatError(error)}`);
        return Response.json({ error: formatError(error) }, { status: 500 });
      }
    },
  });
  log.info(`[ctl] listening on http://${CONTROL_HOST}:${server.port}`);
  return server;
}

async function watch(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
  await ensureHookSchema(sql);
  const pollMs = Math.max(500, cfg.chatgpt.poll_ms ?? 1500);
  const settleMs = cfg.chatgpt.complete_settle_ms ?? 800;
  const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false);
  // Track when we first saw a message as incomplete (for settle debounce)
  const prevIncomplete = new Map<string, number>();
  let lastChatId = "";
  let controlServer: ReturnType<typeof Bun.serve> | undefined;
  const handledHookDownloads = new Set<string>();
  const initializedHookChats = new Set<string>();

  const stop = async () => {
    log.info("\n[watch] stopping...");
    controlServer?.stop(true);
    await context.close();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const page = await getPage(context);
    attachNetworkDebug(page, cfg);
    await openChatGPT(page, cfg);
    controlServer = startControlServer(page, cfg, configPath);
    const sidebarChats = await syncSidebarChats(page, sql, true);
    log.info(`[watch] synchronized ${sidebarChats.length} sidebar chats`);
    log.info(
      `[watch] poll=${pollMs}ms settle=${settleMs}ms ` +
        `conversation=${cfg.chatgpt.conversation_id || "(follow current)"}`
    );

    while (true) {
      try {
        // Refresh visible rows on every tick so renamed titles reach the DB.
        await syncSidebarChats(page, sql, false);
        // If user navigated to another chat, pick it up
        const chat = await scrapeCurrentChat(page);
        if (!chat) {
          log.debug("[watch] no chat visible (login wall or empty home?)");
        } else {
          if (chat.id !== lastChatId) {
            log.info(`[watch] active chat=${chat.id} title="${chat.title}"`);
            lastChatId = chat.id;
            prevIncomplete.clear();
          }
          await persistChat(sql, chat, settleMs, prevIncomplete);
          // Read hook configuration from PostgreSQL every poll so ctl changes
          // take effect without editing config.toml or restarting the watcher.
          const hook = await loadChatHook(sql, chat.id);
          if (hook && hook.enabled) {
            const targets = await findZipTargets(page);
            if (!initializedHookChats.has(chat.id)) {
              // Existing attachments are history, not newly arrived ZIPs.
              for (const target of targets) {
                handledHookDownloads.add(`${chat.id}:${target.identity}`);
              }
              initializedHookChats.add(chat.id);
              log.info(`[hook] initialized ZIP baseline for chat=${chat.id} (${targets.length} existing attachments)`);
            }
            for (const target of targets) {
              const hookKey = `${chat.id}:${target.identity}`;
              if (handledHookDownloads.has(hookKey)) continue;
              // Mark before running: a failed automation must not repeatedly process each poll.
              handledHookDownloads.add(hookKey);
              try {
                const archiveDir = path.resolve(resolveFromConfig(configPath, hook.folder), ".chatgpt-ctl-downloads");
                const archive = await downloadZipTarget(page, target, archiveDir);
                await runHookForZip(page, chat.id, hook, archive, configPath);
              } catch (hookError) {
                log.error(`[hook] chat=${chat.id} failed: ${formatError(hookError)}`);
              }
            }
          }
        }
      } catch (error) {
        log.error(`[watch] scan failed:\n${formatError(error)}`);
      }
      await page.waitForTimeout(pollMs);
    }
  } catch (error) {
    log.error(`[watch] fatal:\n${formatError(error)}`);
    controlServer?.stop(true);
    await context.close();
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
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--config") {
          i++;
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
      return sendMessageCommand(cfg, configPath, textParts.join(" "), files);
    }
    case "login":
      return login(cfg, configPath);
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

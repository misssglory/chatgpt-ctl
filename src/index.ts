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
import { chromium, type BrowserContext, type Page } from "playwright-core";
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

async function commandOutput(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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

/** Open a chat in a normal browser window and leave it running after the CLI exits. */
async function openChatCommand(cfg: Config, configPath: string, rawId: string) {
  const chatId = normalizeUuid(rawId);
  if (!chatId) throw new Error(`open: invalid chat id "${rawId}"`);
  const executablePath = await resolveBrowserExecutable(cfg, configPath);
  const profileDir = resolveFromConfig(configPath, cfg.chatgpt.profile_dir);
  await mkdir(profileDir, { recursive: true });
  const target = new URL(`/c/${chatId}`, cfg.chatgpt.url).toString();
  const proc = Bun.spawn(
    [
      executablePath,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      target,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env }
  );
  proc.unref();
  console.log(target);
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

async function watch(cfg: Config, configPath: string) {
  const sql = openDb(cfg);
  const pollMs = Math.max(500, cfg.chatgpt.poll_ms ?? 1500);
  const settleMs = cfg.chatgpt.complete_settle_ms ?? 800;
  const context = await launchContext(cfg, configPath, cfg.browser?.headless ?? false);
  // Track when we first saw a message as incomplete (for settle debounce)
  const prevIncomplete = new Map<string, number>();
  let lastChatId = "";

  const stop = async () => {
    log.info("\n[watch] stopping...");
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
        }
      } catch (error) {
        log.error(`[watch] scan failed:\n${formatError(error)}`);
      }
      await page.waitForTimeout(pollMs);
    }
  } catch (error) {
    log.error(`[watch] fatal:\n${formatError(error)}`);
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
        `Unknown command '${command}'. Use doctor | login | sync-chats | open | send | migrate | flush | dump | once | watch`
      );
  }
}

main().catch((error) => {
  log.error(formatError(error));
  process.exit(1);
});

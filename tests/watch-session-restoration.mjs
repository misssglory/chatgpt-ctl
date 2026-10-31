import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");

assert.match(source, /CREATE TABLE IF NOT EXISTS chatgpt_watcher_open_chats/,
  "watcher must create persistent open-chat session storage");
assert.match(source, /async function persistOpenChatSession\(/,
  "watcher must snapshot open conversation panes");
assert.match(source, /async function restoreOpenChatSession\(/,
  "watcher must restore saved conversation panes");
assert.match(source, /if \(page\.isClosed\(\)\) continue;[\s\S]*?const chatId = normalizeUuid\(page\.url\(\)\);[\s\S]*?if \(!chatId\) continue/,
  "only pages with a conversation UUID should be saved");

const stopStart = source.indexOf("const stop = async () => {");
const stopEnd = source.indexOf("process.on(\"SIGINT\", stop)", stopStart);
assert.ok(stopStart >= 0 && stopEnd > stopStart, "SIGINT handler must exist");
const stopBody = source.slice(stopStart, stopEnd);
assert.ok(stopBody.indexOf("persistOpenChatSession") < stopBody.indexOf("runtime.context.close"),
  "session must be persisted before browser contexts close");

const restoreCall = source.indexOf("const restoredCount = await restoreOpenChatSession");
const sidebarSyncCall = source.indexOf("await syncSidebarChats(runtime.activePage, sql, true, runtime.name)", restoreCall);
assert.ok(restoreCall >= 0 && sidebarSyncCall > restoreCall,
  "restore must happen before initial sidebar sync and watcher scan");
assert.match(source, /restored virtual focus chat=/,
  "the last focused pane should be restored as virtual focus");
assert.match(schema, /CREATE TABLE IF NOT EXISTS chatgpt_watcher_open_chats/,
  "fresh database schema must include session storage");

console.log("watch session restoration checks passed");

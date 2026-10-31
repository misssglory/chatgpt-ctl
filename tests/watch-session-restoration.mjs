import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");

assert.match(source, /CREATE TABLE IF NOT EXISTS chatgpt_watcher_open_chats/,
  "watcher must create persistent open-chat session storage");
assert.match(source, /async function persistOpenChatSession\(/,
  "watcher must snapshot open conversation panes");
assert.match(source, /function createOpenChatSessionPersistence\(/,
  "watcher must continuously persist session changes through a serialized writer");
assert.match(source, /async function restoreOpenChatSession\(/,
  "watcher must restore saved conversation panes");
assert.match(source, /if \(page\.isClosed\(\)\) continue;[\s\S]*?const chatId = normalizeUuid\(page\.url\(\)\);[\s\S]*?if \(!chatId\) continue/,
  "only pages with a conversation UUID should be saved");

const stopStart = source.indexOf("const stop = async () => {");
const stopEnd = source.indexOf("process.on(\"SIGINT\", stop)", stopStart);
assert.ok(stopStart >= 0 && stopEnd > stopStart, "SIGINT handler must exist");
const stopBody = source.slice(stopStart, stopEnd);
assert.ok(stopBody.indexOf("sessionPersistence.flush()") < stopBody.indexOf("runtime.context.close"),
  "final session checkpoint must flush before browser contexts close");
assert.match(source, /sessionPersistence\.schedule\("watch-shutdown"\)/,
  "shutdown must force a final session checkpoint");

const focusSetterStart = source.indexOf("function setVirtualFocus(");
const focusSetterEnd = source.indexOf("function getVirtualFocus(", focusSetterStart);
const focusSetter = source.slice(focusSetterStart, focusSetterEnd);
assert.match(focusSetter, /focus\.onChange\?\.\("virtual-focus"\)/,
  "virtual focus changes must be persisted");

const trackerStart = source.indexOf("async function installFocusTracking(");
const trackerEnd = source.indexOf("function startControlServer(", trackerStart);
const tracker = source.slice(trackerStart, trackerEnd);
assert.match(tracker, /page\.on\("framenavigated"[\s\S]*?focus\.onChange\?\.\("main-frame-navigation"\)/,
  "manual navigation between chats must schedule a session snapshot");
assert.match(tracker, /page\.on\("close"[\s\S]*?focus\.onChange\?\.\("page-close"\)/,
  "closing a chat tab must schedule a session snapshot");
assert.match(tracker, /runtime\.context\.on\("page"[\s\S]*?focus\.onChange\?\.\("page-created"\)/,
  "new browser tabs must be observed for session persistence");
assert.match(source, /sessionPersistence\.schedule\("poll-observed-route-change"\)/,
  "watcher scan must provide a fallback for observed route changes");

const restoreCall = source.indexOf("const restoredCount = await restoreOpenChatSession");
const sidebarSyncCall = source.indexOf("await syncSidebarChats(runtime.activePage, sql, true, runtime.name)", restoreCall);
assert.ok(restoreCall >= 0 && sidebarSyncCall > restoreCall,
  "restore must happen before initial sidebar sync and watcher scan");
const resumeCall = source.indexOf("sessionPersistence.resume()", restoreCall);
const initialFlushCall = source.indexOf("await sessionPersistence.flush()", resumeCall);
assert.ok(resumeCall > restoreCall && initialFlushCall > resumeCall,
  "continuous persistence must resume only after the complete saved session is restored");
assert.match(source, /restored virtual focus chat=/,
  "the last focused pane should be restored as virtual focus");
assert.match(schema, /CREATE TABLE IF NOT EXISTS chatgpt_watcher_open_chats/,
  "fresh database schema must include session storage");

console.log("watch session restoration and live persistence checks passed");

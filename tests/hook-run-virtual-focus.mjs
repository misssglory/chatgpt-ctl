import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rust = readFileSync(resolve(root, "ctl/src/main.rs"), "utf8");
const server = readFileSync(resolve(root, "src/index.ts"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

assert.match(rust, /Run\s*\{\s*\/\/\/ Optional chat UUID or title; defaults to the virtual-focus conversation\s*chat: Option<String>/s,
  "hook run positional chat argument must be optional");
assert.match(rust, /Commands::Hook \{ action: HookAction::Run \{ chat \} \} => \{\s*run_hook_request\(chat, &url\)/s,
  "run without a chat should avoid CLI-side DB connection and delegate to watcher");
assert.match(rust, /None => "\{\}"\.to_string\(\)/,
  "no chat selector should send an empty body so watcher uses virtual focus");
assert.match(server, /const chatId = requestedChatId \|\| normalizeUuid\(page\.url\(\)\)/,
  "watcher should resolve omitted chat_id from the virtual-focus page URL");
assert.match(server, /const hook = await loadChatHook\(sql, chatId\)/,
  "resolved virtual-focus chat should load its own hook");
assert.match(server, /virtual focus is not on a conversation; use `chatgpt-ctl open <chat>`/,
  "blank pages must fail clearly instead of running another chat's hook");
assert.match(readme, /chatgpt-ctl hook run\s+# run against the virtual-focus chat/,
  "README should document argument-free hook run");

console.log("hook run virtual-focus regression checks passed");

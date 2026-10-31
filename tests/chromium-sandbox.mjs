import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const config = await readFile(new URL("../config.toml", import.meta.url), "utf8");

// All Playwright Chromium launches must explicitly enable the sandbox so the
// Playwright default --no-sandbox argument is omitted.
assert.match(source, /chromiumSandbox:\s*cfg\.browser\?\.chromium_sandbox\s*\?\?\s*true/);
const launchOptions = source.match(/chromium\.launchPersistentContext\(profileDir,\s*\{([\s\S]*?)\}\)/);
assert.ok(launchOptions, "persistent Chromium launch options should exist");
assert.match(launchOptions[1], /chromiumSandbox:/);
const doctorOptions = source.match(/chromium\.launch\(\{([\s\S]*?)\}\)/);
assert.ok(doctorOptions, "doctor Chromium launch options should exist");
assert.match(doctorOptions[1], /chromiumSandbox:/);
assert.match(config, /chromium_sandbox\s*=\s*true/);

// The standalone login process launches regular Chromium directly and does not
// pass a --no-sandbox argument.
const loginBlock = source.slice(source.indexOf("async function login("), source.indexOf("async function dump("));
assert.ok(loginBlock.length > 0, "login function should exist");
assert.doesNotMatch(loginBlock, /--no-sandbox/);

console.log("Chromium sandbox configuration checks passed");

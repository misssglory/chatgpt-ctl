import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const hookStart = source.indexOf("async function runHookForZip(");
const hookEnd = source.indexOf("async function runHookWithLastZip(", hookStart);
assert.ok(hookStart >= 0 && hookEnd > hookStart, "runHookForZip must exist");
const hook = source.slice(hookStart, hookEnd);
const buildAt = hook.indexOf("// Build before touching the Git index.");
const stageAt = hook.indexOf("// Stage only actual files supplied by this archive");
assert.ok(buildAt >= 0 && stageAt > buildAt, "build must run before Git staging");
assert.ok(hook.includes("if (build.code !== 0)"), "nonzero build must be checked");
const failureAt = hook.indexOf("throw new Error(`build failed with exit code");
const addAt = hook.indexOf('commandOutput(["git", "-C", projectDir, "add"');
assert.ok(failureAt > buildAt && addAt > failureAt, "build failure must exit before git add");
assert.ok(hook.includes('"check-ignore", "-z", "--stdin"'), "ignored files must be queried using NUL-delimited paths");
assert.ok(hook.includes("const stageablePaths = archiveFiles.filter((entry) => !ignored.has(entry))"), "ignored archive files must be removed before staging");
console.log("hook transaction order source test passed");

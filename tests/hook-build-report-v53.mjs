import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const hook = src.slice(src.indexOf('async function runHookForZip('), src.indexOf('async function runHookWithLastZip('));
const send = src.slice(src.indexOf('async function sendInPage('), src.indexOf('async function runHookForZip('));

test('build failure reports wcc -o stdout without clipboard and persists large logs', () => {
  assert.match(hook, /const diagnostic = result.stdout \|\| result.stderr/);
  assert.doesNotMatch(hook, /commandOutput\(clipboardCommand/);
  assert.match(hook, /writeFile\(logFile, [\s\S]*diagnostic/);
  assert.match(hook, /defaultBuildCommand = hookDefaults/);
});
test('submission resolves button in current composer form and does not trust click alone', () => {
  assert.match(send, /composer\.locator\('xpath=ancestor::form\[1\]'\)/);
  assert.match(send, /const scopedSend = form\.locator\(sendButtonSelector\)/);
  assert.match(send, /const button = await chooseSendButton\(\)/);
  assert.match(send, /if \(await observed\(\)\)/);
});

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const hook = src.slice(src.indexOf('async function runHookForZip('), src.indexOf('async function runHookWithLastZip('));
const send = src.slice(src.indexOf('async function sendInPage('), src.indexOf('async function runHookForZip('));

test('build failure reports actual captured output before using bounded clipboard fallback', () => {
  assert.match(hook, /let diagnostic = \[result\.stderr, result\.stdout\]\.filter\(Boolean\)\.join\("\\n"\)/);
  assert.match(hook, /if \(!diagnostic\.trim\(\)\)/);
  assert.match(hook, /commandOutput\(clipboardCommand, undefined, undefined, 3_000\)/);
  assert.match(hook, /diagnostic\.slice\(-24_000\)/);
});
test('submission resolves button in current composer form and does not trust click alone', () => {
  assert.match(send, /composer\.locator\('xpath=ancestor::form\[1\]'\)/);
  assert.match(send, /const scopedSend = form\.locator\(sendButtonSelector\)/);
  assert.match(send, /const button = await chooseSendButton\(\)/);
  assert.match(send, /if \(await observed\(\)\)/);
});

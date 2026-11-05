import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const send = src.slice(src.indexOf('async function sendInPage('), src.indexOf('async function runHookForZip('));
test('hook diagnostic only logs submission after observing new matching user message', () => {
  assert.match(send, /const existingUserIds = new Set\(/);
  assert.match(send, /!existingUserIds\.has\(m\.id\)/);
  assert.match(send, /startsWith\(expected\)/);
  assert.match(send, /if \(await observed\(\)\)/);
  assert.match(send, /\[send\] confirmed submitted/);
  assert.doesNotMatch(send, /await page\.waitForTimeout\(700\);\s*log\.info\(`\[send\] submitted/);
});
test('retries only when composer retains a draft, avoiding duplicate delivery', () => {
  assert.match(send, /for \(let attempt = 1; attempt <= 3; attempt\+\+\)/);
  assert.match(send, /if \(emptied \|\| !\(await composerText\(\)\)\.trim\(\)\)/);
  assert.match(send, /submission uncertain \(no automatic retry\)/);
  assert.match(send, /filter\(\{ visible: true \}\)/);
});

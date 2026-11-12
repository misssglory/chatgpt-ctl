import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('manual hook uses its own assistant ZIP readiness gate, not full conversation history wait', () => {
  const manual = src.slice(src.indexOf('async function runHookWithLastZip('), src.indexOf('function openConversationPages(', src.indexOf('async function runHookWithLastZip(')));
  assert.match(manual, /waitForHookDownloadReady\(page, chatId/);
  assert.doesNotMatch(manual, /waitForConversationReady\(page, chatId/);
  assert.match(manual, /assistantZipTargets\(await findZipTargets\(page\), current\.messages\)/);
});
test('manual readiness requires right URL, completed assistant and assistant-owned ZIP, with stable samples', () => {
  const ready = src.slice(src.indexOf('async function waitForHookDownloadReady('),src.indexOf('async function runHookWithLastZip('));
  assert.match(ready, /normalizeUuid\(page\.url\(\)\)/);
  assert.match(ready, /routeId !== chatId/);
  assert.match(ready, /!chat\.isStreaming/);
  assert.match(ready, /m\.role === "assistant" && m\.completed/);
  assert.match(ready, /assistantZipTargets\(await findZipTargets\(page\), chat\.messages\)/);
  assert.match(ready, /stable >= 1/);
});
test('newly opened manual hook panes avoid redundant full-history wait', () => {
  assert.match(src, /if \(url\.pathname !== "\/hook\/run"\) \{\s*await waitForConversationReady\(page, requestedChatId/);
});
test('watcher readiness cancels a stale route before waiting 45 seconds', () => {
  const ready = src.slice(src.indexOf('async function waitForConversationReady('),src.indexOf('function configurePage('));
  assert.match(ready, /conversation route changed while loading/);
});

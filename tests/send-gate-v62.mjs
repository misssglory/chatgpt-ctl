import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ctl = readFileSync(new URL('../ctl/src/main.rs', import.meta.url), 'utf8');

test('send waits for the previous completed assistant turn before touching the composer', () => {
  const gate = src.indexOf('await waitForSendGate(page, requestedChatId || normalizeUuid(page.url()))');
  const composer = src.indexOf('if (sendExisting) {', gate);
  const send = src.indexOf('await sendInPage(page, text, undefined, files, !draft)', composer);
  assert.ok(gate > 0 && gate < composer && composer < send);
  assert.match(src, /if \(!latest\) return "awaiting previous assistant answer"/);
  assert.match(src, /if \(chat\.isStreaming\) return "previous assistant answer is still generating"/);
});

test('send waits for hook processing and retries before submission', () => {
  assert.match(src, /sendGate\.activeHooks\.has\(chatId\)/);
  assert.match(src, /sendGate\.pendingZips\.keys\(\)/);
  assert.match(src, /sendGate\.checkedAssistants\.get\(chatId\) !== latest\.id/);
  assert.match(src, /hookCheckedAssistantByChat\.set\(chat\.id, latestAssistant\.id\)/);
  assert.match(src, /if \(sendGate\.activeHooks\.has\(chatId\)\) throw new Error\(`hook already running/);
});

test('CLI prints actionable waiting status, drafts and new-chat remain exempt', () => {
  assert.match(ctl, /Awaiting previous answer and hook:/);
  assert.match(ctl, /if !draft && !new_chat/);
  assert.match(src, /if \(!draft && !body\.new_chat\)/);
  assert.match(src, /url\.pathname === "\/send\/readiness"/);
  assert.match(src, /send: timed out awaiting previous answer and hook/);
});

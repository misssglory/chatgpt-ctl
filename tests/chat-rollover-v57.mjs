import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { conversationLengthLimitPattern as limit } from '../src/conversation-length-limit.mjs';
const code=fs.readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const ctl=fs.readFileSync(new URL('../ctl/src/main.rs',import.meta.url),'utf8');
const schema=fs.readFileSync(new URL('../sql/schema.sql',import.meta.url),'utf8');

test('known conversation-length prompts recognized without treating normal chat text as UI',()=>{
  for(const text of ['This conversation has reached its maximum length.',
    'This conversation has reached its limit. Start a new chat.',
    'Conversation is too long',
    'You have reached the chat length limit']) assert.match(text,limit);
  for(const text of ['This is a normal ChatGPT conversation', 'Please continue building ZIP files',
    'What is the maximum file size?']) assert.doesNotMatch(text,limit);
  assert.match(code,/closest\('\[data-message-author-role\]/);
});
test('successor starts first, then archive is refreshed and checked',()=>{
  const i=code.indexOf('const proc = Bun.spawn([userShell, shellFlag, "wcz ."]');
  const j=code.indexOf('successor = await runtime.context.newPage()');
  const linked=code.indexOf('INSERT INTO chatgpt_watcher_chat_links',j);
  assert.ok(i>j&&j>0&&linked>j&&linked<i);
  assert.match(code,/info\.mtimeMs < started/);
  assert.match(code,/archive is not a ZIP/);
  assert.match(code,/unzip", "-tqq"/);
});
test('first send creates actual chat id; rollover link and copied hook precede draft',()=>{
  const section=code.slice(code.indexOf('const rolloverChats = async'),code.indexOf('const handledHookDownloads'));
  assert.ok(section.indexOf('await sendInPage(successor,')<section.indexOf('nextId = normalizeUuid'));
  assert.ok(section.indexOf('INSERT INTO chatgpt_watcher_chat_links')<section.indexOf('await sendInPage(successor, "", undefined, [archive], false)'));
  assert.match(section,/INSERT INTO chat_hooks/);
  assert.match(section,/if \(!alreadyDrafted\)/);
});
test('manual links have ordered CLI syntax and cycle protection',()=>{
  assert.match(ctl,/Commands::Link \{ previous, next \}/);
  assert.match(ctl,/Commands::Links \{ chat \}/);
  assert.match(ctl,/link would create a cycle/);
  assert.match(schema,/previous_chat_id uuid PRIMARY KEY/);
  assert.match(schema,/next_chat_id uuid NOT NULL UNIQUE/);
});
test('draft does not require visible Send button',()=>{
  const i=code.indexOf('if (!submit) {\n    // Drafts do not need a Send button');
  const j=code.indexOf('const readySendButton = await chooseSendButton()',i);
  assert.ok(i>0&&j>i);
});

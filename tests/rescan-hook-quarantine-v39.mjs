import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
// The barrier must be chat-level and survive the page-level finally cleanup.
assert.match(source, /const rescanHookQuarantine = new Map<string, Set<string>>\(\)/);
assert.match(source, /rescanHookQuarantine\.set\(chatId, new Set\(\)\)/);
assert.match(source, /rescanHookQuarantine\.set\(chatId, new Set\(messages\.filter\(m => m\.role === "user"\)\.map\(m => m\.id\)\)\)/);
assert.match(source, /rescanHookQuarantine\.get\(chat\.id\)/);
assert.match(source, /quarantinedUserIds\.size > 0 && chat\.messages\.some/);
assert.match(source, /m\.role === "user" && !quarantinedUserIds\.has\(m\.id\)/);
assert.match(source, /rescanHookQuarantine\.delete\(chat\.id\)/);
assert.match(source, /unseen\.length && !activeHookChats\.has\(chat\.id\) && !rescanHookQuarantine\.has\(chat\.id\)/);
assert.match(source, /discarded auto ZIP after rescan began/);
// This models the reported history scan: old messages must not release the barrier.
const userIds = new Set(['old-user-1','old-user-2']);
function shouldRelease(messages) { return userIds.size > 0 && messages.some(m => m.role === 'user' && !userIds.has(m.id)); }
assert.equal(shouldRelease([{role:'assistant',id:'historic-zip-14'},{role:'user',id:'old-user-1'}]),false);
assert.equal(shouldRelease([{role:'user',id:'old-user-2'}]),false);
assert.equal(shouldRelease([{role:'user',id:'new-user-3'}]),true);
assert.equal(new Set().size > 0,false);
console.log('rescan hook quarantine regression checks passed');

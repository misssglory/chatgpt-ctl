import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
const rust = readFileSync(new URL('../ctl/src/main.rs', import.meta.url), 'utf8');
test('rescan-all index-only exits after inventory and before worker pool', () => {
  assert.match(rust, /index_only: bool/);
  assert.match(rust, /if index_only \{[\s\S]*?return Ok\(\(\)\);[\s\S]*?\}[\s\S]*?\[scan\] START/);
});
test('files open-chat grouped fzf preview and browser focus', () => {
  assert.match(rust, /open_chat: bool/);
  assert.match(rust, /browse_files_open_chat/);
  assert.match(rust, /FILES_OPEN_CHAT_FILTER/);
  assert.match(rust, /change:reload:/);
  assert.match(rust, /"POST", "\/open"/);
  assert.match(rust, /len\(scored\)/);
});

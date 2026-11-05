import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const src = readFileSync(new URL('../ctl/src/watch.rs', import.meta.url), 'utf8');
test('viewer wraps by default with reversible key binding', () => {
  assert.match(src, /word_wrap:true/);
  assert.match(src, /KeyCode::Char\('w'\)\s*=>\s*\{m\.word_wrap=!m\.word_wrap/);
  assert.match(src, /paragraph\.wrap\(Wrap \{ trim: false \}\)/);
});
test('assistant answer code fences carry language into syntax colorizer', () => {
  assert.match(src, /fn assistant_answer_lines\(/);
  assert.match(src, /syntax_line\(source, language, query/);
  assert.match(src, /lines\.extend\(assistant_answer_lines\(&t\.answers/);
});

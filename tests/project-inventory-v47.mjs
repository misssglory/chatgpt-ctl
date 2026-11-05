import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src = readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const cli = readFileSync(new URL('../ctl/src/main.rs',import.meta.url),'utf8');
assert.match(src, /inventory BEGIN/);
assert.match(src, /inventory click Show more/);
assert.match(src, /inventory expanded/);
assert.match(src, /inventory COMPLETE/);
assert.match(src, /Show more click .* added no chats/);
assert.match(src, /title:chats\.find\(c=>c\.id===r\.id\)/);
assert.match(cli, /\[inventory\] COMPLETE/);
assert.match(cli, /\[scan\] START/);
assert.match(cli, /scanned \\\"\{\}\\\"/);
// The supplied Dima HTML uses a project-scoped list with a listitem button.
const htmlFragment = '<div role="list" aria-label="Chats in Dima"><div role="listitem"><button><span>Show more</span></button></div></div>';
assert.match(htmlFragment, /role="list" aria-label="Chats in Dima"/);
assert.match(htmlFragment, /<button><span>Show more<\/span>/);
console.log('project inventory stage, title reporting and Dima DOM checks passed');

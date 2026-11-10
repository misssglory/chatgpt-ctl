import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const rust=fs.readFileSync(new URL('../ctl/src/main.rs',import.meta.url),'utf8');

test('ZIP scanner recognizes DIL pressable role links without aria-label',()=>{
 const scanner=source.slice(source.indexOf('async function findZipTargets('),source.indexOf('async function waitForDownload('));
 assert.match(scanner,/const selector = 'a\[href\], \[role="link"\], button\[aria-label\]'/);
 assert.match(scanner,/isDescriptiveZipLink/);
 assert.match(scanner,/data-dil-message-id/);
 assert.match(scanner,/data-chatgpt-search-message-ids/);
});
test('manual hook uses verified assistant files when primary ZIP selection fails',()=>{
 const fn=source.slice(source.indexOf('async function runHookWithLastZip('),source.indexOf('function openConversationPages('));
 assert.match(fn,/downloadFromChatFilesPanel\(page, menuZip, archiveDir, true\)/);
 assert.match(fn,/file.role === "assistant"/);
 assert.match(fn,/retrieveFileFromControl\(page, file, archiveDir\)/);
 assert.match(fn,/magic\[0\] === 0x50 && magic\[1\] === 0x4b/);
});
test('send no args preserves populated composer and submits',()=>{
 assert.match(rust,/let send_existing = text\.trim\(\)\.is_empty\(\) && files\.is_empty\(\) && !draft && !new_chat/);
 assert.match(rust,/"send_existing": send_existing/);
 assert.match(source,/const sendExisting = Boolean\(body\.send_existing\)/);
 assert.match(source,/await sendInPage\(page, text, undefined, files, !draft\)/);
});

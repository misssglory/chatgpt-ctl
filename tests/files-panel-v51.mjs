import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
test('Files-in-chat panel is tried before virtualized message history retrieval', () => {
 const a = src.indexOf('async function downloadChatFile(');
 const b = src.indexOf('async function findIndexedFileInHistory(', a);
 const body = src.slice(a, src.indexOf('async function ', a+20));
 assert.ok(body.indexOf('downloadFromChatFilesPanel(page, requestedName, directory)') < body.indexOf('findIndexedFileInHistory(page, expectedChatId, identity)'));
});
test('hook run compares last chat ZIP with Files-in-chat ZIP and verifies selected archive', () => {
 const body = src.slice(src.indexOf('async function runHookWithLastZip('), src.indexOf('function openConversationPages('));
 assert.match(body,/fileNameForDownload\(menuZip\).*fileNameForDownload\(selectedChatZip\.label\)/s);
 assert.match(body,/downloadFromChatFilesPanel\(page, menuZip, archiveDir, true\)/);
 assert.match(body,/archive \|\|= await downloadLastZip/);
});
test('Files-in-chat exact scoped filename and viewer header Download', () => {
 assert.match(src,/\[role="tabpanel"\]\[aria-label="Files in chat"\]/);
 assert.match(src,/ul\[aria-label="Files in chat"\] > li > button\[aria-label\]/);
 assert.match(src,/\[data-testid="viewer-header"\]/);
 assert.match(src,/suggested\.toLowerCase\(\) !== fileNameForDownload\(filename\)\.toLowerCase\(\)/);
});

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
test('hook run prioritizes newest assistant message and rejects stale Files-in-chat archives', () => {
 const body = src.slice(src.indexOf('async function runHookWithLastZip('), src.indexOf('function openConversationPages('));
 assert.match(body,/chatTargets\[0\]/);
 assert.doesNotMatch(body,/downloadFromChatFilesPanel\(page, menuZip/);
 assert.match(body,/archive = await downloadLastZip/);
 assert.match(body,/retrieveFileFromControl\(page, file, archiveDir\)/);
});
test('Files-in-chat exact scoped filename and viewer header Download', () => {
 assert.match(src,/\[role="tabpanel"\]\[aria-label="Files in chat"\]/);
 assert.match(src,/ul\[aria-label="Files in chat"\] > li > button\[aria-label\]/);
 assert.match(src,/\[data-testid="viewer-header"\]/);
 assert.match(src,/suggested\.toLowerCase\(\) !== fileNameForDownload\(filename\)\.toLowerCase\(\)/);
});

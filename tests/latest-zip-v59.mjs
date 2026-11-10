import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const scanner=source.slice(source.indexOf('async function findZipTargets('),source.indexOf('async function waitForDownload('));
const downloader=source.slice(source.indexOf('async function downloadLastZip('),source.indexOf('async function sendInPage('));
const hook=source.slice(source.indexOf('async function runHookWithLastZip('),source.indexOf('function openConversationPages('));
test('v0.4.0 text-only DIL download link is recognized without .zip extension',()=>{
  assert.match(scanner,/\^Download\\s\+\\S/);
  assert.match(scanner,/isGeneratedDownload/);
});
test('manual ZIP downloader cannot fall back to older candidates',()=>{
  assert.match(downloader,/const target = candidates\[0\]!/);
  assert.doesNotMatch(downloader,/for \(const target of candidates\)/);
  assert.match(downloader,/refusing to build an older ZIP/);
  assert.match(downloader,/retrieveFileFromControl\(page, matches\[0\]!, directory\)/);
});
test('manual hook does not prefer possibly stale Files-in-chat menu',()=>{
  assert.match(hook,/chatTargets\[0\]/);
  assert.doesNotMatch(hook,/menuZip/);
});

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const hook = src.slice(src.indexOf('async function runHookForZip('), src.indexOf('async function runHookWithLastZip('));
const control = src.slice(src.indexOf('if ((url.pathname === "/hook/run" || url.pathname === "/download-last-zip")'), src.indexOf('if (url.pathname === "/download-last-zip") {', src.indexOf('if ((url.pathname === "/hook/run" || url.pathname === "/download-last-zip")')));
test('large build diagnostics are persisted whole and attached', () => {
 assert.match(hook, /if \(report.length > failureReportMaxChars\)/);
 assert.match(hook, /await writeFile\(logFile,/);
 assert.match(hook, /attachments.push\(logFile\)/);
 assert.match(hook, /sendInPage\(page, report, chatId, attachments\)/);
 assert.doesNotMatch(hook, /diagnostic.slice\(/);
});
test('explicit hook target focuses before build and does not await focus call', () => {
 assert.match(control, /setVirtualFocus\(focus, runtime, page, "ctl"\)/);
 assert.match(control, /void page.bringToFront\(\)/);
 assert.ok(control.indexOf('void page.bringToFront()') < control.indexOf('await runHookWithLastZip('));
});

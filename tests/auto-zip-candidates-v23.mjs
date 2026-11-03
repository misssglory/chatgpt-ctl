import assert from 'node:assert/strict';
import { autoZipCandidates } from '../src/auto-zip-candidates.mjs';
import { zipTargetsAfterCursor } from '../src/zip-cursor.mjs';
const sameTurn = [
 {identity:'assistant-a|Download updated project v2',messageOrder:7},
 {identity:'assistant-a|Download updated project v1',messageOrder:7},
];
const handled = new Set([sameTurn[1].identity]);
const staleCursor = {targetIdentity:'missing old anchor',turnOrder:7};
// Previous implementation incorrectly found no new candidates because the
// cursor's turn matched the new attachment and the old anchor was absent.
assert.equal(zipTargetsAfterCursor(sameTurn, staleCursor).length,0);
assert.deepEqual(autoZipCandidates(sameTurn,handled,staleCursor.targetIdentity),[sameTurn[0]]);
assert.deepEqual(autoZipCandidates(sameTurn,new Set(sameTurn.map(t=>t.identity)),staleCursor.targetIdentity),[]);
assert.deepEqual(autoZipCandidates(sameTurn,new Set(),sameTurn[0].identity),[sameTurn[1]]);
const newestFirst=[{identity:'newest',messageOrder:9},{identity:'older',messageOrder:8}];
assert.deepEqual(autoZipCandidates(newestFirst,new Set(['older'])) , [newestFirst[0]]);
console.log('automatic ZIP attachment arrival tests passed');

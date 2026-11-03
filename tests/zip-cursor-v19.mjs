import assert from 'node:assert/strict';
import { zipTargetsAfterCursor, zipTargetIsAfterCursor } from '../src/zip-cursor.mjs';
const targets=[
 {identity:'turn-4|ChatGPT History Watcher v0.1.18', messageOrder:4},
 {identity:'turn-3|ChatGPT History Watcher v0.1.17', messageOrder:3},
 {identity:'turn-2|ChatGPT History Watcher v0.1.16', messageOrder:2},
];
const stale={targetIdentity:targets[2].identity,turnOrder:4};
assert.deepEqual(zipTargetsAfterCursor(targets,stale).map(x=>x.messageOrder),[4,3]);
assert.equal(zipTargetIsAfterCursor(targets[0],targets,stale),true);
assert.equal(zipTargetIsAfterCursor(targets[2],targets,stale),false);
assert.deepEqual(zipTargetsAfterCursor(targets,{targetIdentity:targets[0].identity,turnOrder:4}),[]);
assert.deepEqual(zipTargetsAfterCursor(targets,{targetIdentity:'missing',turnOrder:3}).map(x=>x.messageOrder),[4]);
console.log('ZIP cursor timeline tests passed');

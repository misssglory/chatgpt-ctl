import assert from 'node:assert/strict';
import { freshZipCandidates } from '../src/fresh-zip-candidates.mjs';
import { autoZipCandidates } from '../src/auto-zip-candidates.mjs';
const targets = [
  { identity:'old', messageOrder:12, messageId:'old-id' },
  { identity:'late-current', messageOrder:20, messageId:'current-id' },
  { identity:'new-turn', messageOrder:21, messageId:'new-id' },
  { identity:'unknown-old', messageOrder:null, messageId:'unknown-old-id' },
];
assert.deepEqual(freshZipCandidates(targets,20).map(x=>x.identity),['late-current','new-turn']);
assert.deepEqual(freshZipCandidates(targets,20,new Set(['unknown-old-id'])).map(x=>x.identity),['late-current','new-turn','unknown-old']);
const accepted = freshZipCandidates(targets,20);
assert.deepEqual(autoZipCandidates(accepted,new Set(['late-current'])).map(x=>x.identity),['new-turn']);
assert.deepEqual(freshZipCandidates(targets,22).map(x=>x.identity),[]);
console.log('fresh ZIP hook scroll regression checks passed');

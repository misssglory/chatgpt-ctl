import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { zipTargetAssociation } from "../src/zip-target-selection.mjs";

const assistant = { id: "367142c0-803d-4441-8860-496e9286340b", turnOrder: 4 };

assert.equal(
  zipTargetAssociation({ messageId: assistant.id, messageOrder: 4 }, assistant),
  "message-id",
  "exact message UUID should be the preferred association",
);
assert.equal(
  zipTargetAssociation({ messageId: "fd4f45d6-f538-405d-92d5-b5ab12cfd8f5", messageOrder: 4 }, assistant),
  "turn-order",
  "DIL portal UUID mismatch should match the exact latest turn",
);
assert.equal(
  zipTargetAssociation({ messageId: "fd4f45d6-f538-405d-92d5-b5ab12cfd8f5", messageOrder: 3 }, assistant),
  null,
  "an older turn must never be selected",
);
assert.equal(
  zipTargetAssociation({ messageId: null, messageOrder: null }, assistant),
  null,
  "unknown association must fail closed",
);
assert.equal(
  zipTargetAssociation({ messageId: assistant.id, messageOrder: null }, { id: assistant.id }),
  "message-id",
  "exact message identity should work when turn metadata is unavailable",
);

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
assert.match(source, /function latestAssistantFromMessages\(/, "latest assistant selector should be shared by manual and automatic hooks");
assert.match(source, /const numberedAssistants = assistants\.filter\(\(message\) => message\.turnOrder !== undefined\)/,
  "latest assistant selection should prefer explicit stable turn numbers");
assert.match(source, /targets\.filter\(\(target\) => zipTargetAssociation\(target, expectedAssistant\) !== null\)/,
  "manual ZIP selection should use message UUID or exact-turn association");
assert.match(source, /!hasNewUserTurn \|\| !latestAssistant \|\| !zipTargetAssociation\(target, latestAssistant\)/,
  "automatic ZIP hooks should use the same association policy");

console.log("ZIP target association tests passed");

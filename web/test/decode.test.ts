import assert from "node:assert/strict";
import { test } from "node:test";
import { encode } from "@msgpack/msgpack";
import { decodeEntry, timestampOf } from "../src/holochain/decode.ts";
import type { HcRecord } from "../src/holochain/types.ts";

// A record as Holochain 0.7 sends it: the action's author and timestamp
// under `header`, its kind-specific fields under `data`.
const key = new Uint8Array(39);
const record = {
  signed_action: {
    hashed: {
      hash: key,
      content: {
        header: { author: key, timestamp: 1_791_511_794_117_259, action_seq: 48, prev_action: key },
        data: { type: "Create", entry_type: { App: { entry_index: 0, zome_index: 0, visibility: "Public" } }, entry_hash: key },
      },
    },
    signature: new Uint8Array(64),
  },
  entry: { Present: { entry_type: "App", entry: encode({ name: "Soup" }) } },
} as unknown as HcRecord;

test("a record's timestamp is read from its action's header", () => {
  const at = timestampOf(record);
  assert.equal(at, 1_791_511_794_117_259);
  assert.ok(!Number.isNaN(new Date(at / 1000).getTime()), "and makes a real date");
});

test("a record's entry decodes to the struct it holds", () => {
  assert.deepEqual(decodeEntry<{ name: string }>(record), { name: "Soup" });
});

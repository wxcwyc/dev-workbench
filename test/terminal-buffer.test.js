import assert from "node:assert/strict";
import test from "node:test";

import { TerminalBuffer } from "../packages/execution-core/src/terminal-buffer.js";

const fixedTime = "2026-07-27T00:00:00.000Z";
const now = () => fixedTime;

function output(overrides = {}) {
  return {
    source: "preview:source",
    stream: "stdout",
    text: "ready\n",
    ...overrides,
  };
}

test("append creates terminal output events with per-session sequences", () => {
  const buffer = new TerminalBuffer({ maxBytes: 12, now });

  assert.deepEqual(buffer.append("session-1", output()), {
    type: "terminal.output",
    sequence: 1,
    source: "preview:source",
    stream: "stdout",
    text: "ready\n",
    at: fixedTime,
  });
  assert.equal(buffer.append("session-1", output({
    source: "preview:target",
    stream: "stderr",
    text: "warn\n",
  })).sequence, 2);
  assert.equal(buffer.append("session-2", output({ source: "step:0" })).sequence, 1);
});

test("append rejects invalid input without changing session state", () => {
  const buffer = new TerminalBuffer({ now });
  buffer.append("session-1", output());
  const before = buffer.snapshot("session-1");

  const invalidCalls = [
    () => buffer.append("", output()),
    () => buffer.append(null, output()),
    () => buffer.snapshot(""),
    () => buffer.subscribe("", () => {}),
    () => buffer.delete(""),
    () => buffer.append("session-1", output({ source: "preview:other" })),
    () => buffer.append("session-1", output({ source: "step:-1" })),
    () => buffer.append("session-1", output({ source: "step:1.5" })),
    () => buffer.append("session-1", output({ stream: "stdin" })),
    () => buffer.append("session-1", output({ text: "" })),
    () => buffer.append("session-1", output({ text: 42 })),
  ];

  for (const call of invalidCalls) assert.throws(call);

  assert.deepEqual(buffer.snapshot("session-1"), before);
  assert.deepEqual(buffer.snapshot("missing"), { events: [], latestSequence: 0 });
});

test("eviction counts UTF-8 bytes and removes the oldest whole events", () => {
  const buffer = new TerminalBuffer({ maxBytes: 7, now });

  buffer.append("session-1", output({ text: "éé" }));
  buffer.append("session-1", output({ stream: "stderr", text: "abc" }));
  assert.deepEqual(
    buffer.snapshot("session-1").events.map(({ text }) => text),
    ["éé", "abc"],
  );

  buffer.append("session-1", output({ text: "x" }));
  const snapshot = buffer.snapshot("session-1");
  assert.deepEqual(snapshot.events.map(({ text }) => text), ["abc", "x"]);
  assert.equal(snapshot.latestSequence, 3);
});

test("one oversized event keeps the newest complete UTF-8 suffix", () => {
  const buffer = new TerminalBuffer({ maxBytes: 5, now });

  buffer.append("session-1", output({ text: "old!" }));
  const appended = buffer.append("session-1", output({ text: "a😀bc" }));

  assert.equal(appended.text, "bc");
  assert.equal(Buffer.byteLength(appended.text, "utf8") <= 5, true);
  assert.equal(appended.text.includes("\uFFFD"), false);
  assert.deepEqual(buffer.snapshot("session-1"), {
    events: [appended],
    latestSequence: 2,
  });
});

test("snapshot returns a defensive clone and an empty snapshot for unknown sessions", () => {
  const buffer = new TerminalBuffer({ now });
  buffer.append("session-1", output());

  const first = buffer.snapshot("session-1");
  first.events[0].text = "changed";
  first.events.push({ sequence: 99 });
  first.latestSequence = 99;

  assert.deepEqual(buffer.snapshot("session-1"), {
    events: [{
      type: "terminal.output",
      sequence: 1,
      source: "preview:source",
      stream: "stdout",
      text: "ready\n",
      at: fixedTime,
    }],
    latestSequence: 1,
  });
  assert.deepEqual(buffer.snapshot("unknown"), { events: [], latestSequence: 0 });
});

test("subscribers receive only their session after the event is stored", () => {
  const buffer = new TerminalBuffer({ now });
  const received = [];
  const unsubscribe = buffer.subscribe("session-1", (event) => {
    received.push({
      event,
      snapshot: buffer.snapshot("session-1"),
    });
  });

  const first = buffer.append("session-1", output());
  buffer.append("session-2", output({ text: "other" }));
  unsubscribe();
  buffer.append("session-1", output({ text: "after unsubscribe" }));

  assert.deepEqual(received, [{
    event: first,
    snapshot: { events: [first], latestSequence: 1 },
  }]);
});

test("a throwing subscriber does not block append or other subscribers", () => {
  const buffer = new TerminalBuffer({ now });
  const received = [];
  buffer.subscribe("session-1", () => {
    throw new Error("listener failed");
  });
  buffer.subscribe("session-1", (event) => received.push(event));

  let event;
  assert.doesNotThrow(() => {
    event = buffer.append("session-1", output());
  });

  assert.deepEqual(received, [event]);
  assert.deepEqual(buffer.snapshot("session-1").events, [event]);
});

test("delete drops events, sequence, and subscribers", () => {
  const buffer = new TerminalBuffer({ now });
  const received = [];
  buffer.subscribe("session-1", (event) => received.push(event));
  buffer.append("session-1", output());

  buffer.delete("session-1");

  assert.deepEqual(buffer.snapshot("session-1"), { events: [], latestSequence: 0 });
  const event = buffer.append("session-1", output({ text: "new" }));
  assert.equal(event.sequence, 1);
  assert.deepEqual(received.map(({ text }) => text), ["ready\n"]);
});

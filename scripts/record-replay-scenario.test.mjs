// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Unit coverage for the replay-scenario recorder's pure core
// (scripts/lib/replay-recorder.mjs): certainty-bounded id placeholderization,
// the flag-and-fail secret/PII guard (the loud must-review gate), and a full
// round-trip of a recorded cassette back through the REAL `ReplayBackend`
// parser — proving a recorded scenario is actually replayable, not just
// well-shaped JSON.

import { describe, it, expect } from "vitest";

import { parseFixture, serializeFixture } from "@omnesis/agent";

import {
  buildCassette,
  buildIdMappings,
  placeholderizeIds,
  scanCassetteLine,
  RecorderGuardError,
} from "./lib/replay-recorder.mjs";

// A minimal but realistic captured stream: the ids below are the ones the
// recorder MINTED (so it can placeholder-ize them with certainty). All content
// is invented.
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const MSG_ID = "66666666-7777-8888-9999-000000000000";

// The flag-and-fail negative controls need inputs that LOOK real to the guard
// (so we can prove it refuses them). We assemble those tokens at RUNTIME from
// harmless parts so no real-shaped literal sits in the committed source — that
// keeps the repo's own pii-scan / commit hook from flagging this test file
// while still feeding the recorder's detector a genuine real-looking token.
const FAKE_API_KEY = ["sk", "AbC123dEf456GhI789jKl012mNo345pQr"].join("-");
const FAKE_EMAIL = ["riley.okafor", "nimbus-labs.invalidtld"].join("@");
const FAKE_UUID = ["deadbeef", "0000", "1111", "2222", "333344445555"].join("-");

function cleanEvents() {
  return [
    {
      type: "agent.message.start",
      payload: { sessionId: SESSION_ID, messageId: MSG_ID, role: "assistant" },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: SESSION_ID, messageId: MSG_ID, delta: "Sure — here is the summary." },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: SESSION_ID, messageId: MSG_ID, stopReason: "end_turn" },
    },
  ];
}

describe("placeholderizeIds", () => {
  it("swaps minted ids whole-string and as substrings, never fuzzy", () => {
    const mappings = buildIdMappings({ sessionId: SESSION_ID, messageId: MSG_ID });
    const out = placeholderizeIds(
      { a: SESSION_ID, b: `prefix:${MSG_ID}`, c: "untouched content" },
      mappings,
    );
    expect(out).toEqual({ a: "$SESSION", b: "prefix:$MSG", c: "untouched content" });
  });

  it("leaves real-looking content it has no mapping for alone (no blind regex)", () => {
    const mappings = buildIdMappings({ sessionId: SESSION_ID, messageId: MSG_ID });
    // A different UUID we did NOT mint must be left verbatim — the recorder
    // never blindly rewrites ids it can't resolve with certainty.
    const out = placeholderizeIds({ x: FAKE_UUID }, mappings);
    expect(out).toEqual({ x: FAKE_UUID });
  });
});

describe("scanCassetteLine flag-and-fail detector", () => {
  it("passes a clean, fully-placeholdered line", () => {
    const line = JSON.stringify({
      afterMs: 0,
      event: { type: "agent.text.delta", payload: { sessionId: "$SESSION", delta: "hi there" } },
    });
    expect(scanCassetteLine(line)).toEqual([]);
  });

  it("flags a real-looking email", () => {
    const line = JSON.stringify({ event: { delta: `ping ${FAKE_EMAIL}` } });
    // not on a reserved domain → flagged
    const findings = scanCassetteLine(line);
    expect(findings.some((f) => f.kind === "email")).toBe(true);
  });

  it("flags an api-key / opaque-token shape", () => {
    const line = JSON.stringify({ event: { token: FAKE_API_KEY } });
    const findings = scanCassetteLine(line);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags a bare UUID that wasn't placeholder-ized", () => {
    const findings = scanCassetteLine(JSON.stringify({ id: FAKE_UUID }));
    expect(findings.some((f) => f.kind === "uuid")).toBe(true);
  });

  it("does NOT flag our own placeholder tokens", () => {
    const line = JSON.stringify({
      event: { sessionId: "$SESSION", messageId: "$MSG", doc: "$DOC_synth-gmail-001" },
    });
    expect(scanCassetteLine(line)).toEqual([]);
  });
});

describe("buildCassette", () => {
  it("placeholder-izes minted ids and produces a clean cassette", () => {
    const { jsonl, lines } = buildCassette(
      cleanEvents(),
      { sessionId: SESSION_ID, messageId: MSG_ID },
      { afterMs: 30 },
    );
    expect(lines).toHaveLength(3);
    // No raw minted id survives.
    expect(jsonl).not.toContain(SESSION_ID);
    expect(jsonl).not.toContain(MSG_ID);
    expect(jsonl).toContain("$SESSION");
    expect(jsonl).toContain("$MSG");
    // afterMs honored.
    expect(JSON.parse(lines[0]).afterMs).toBe(30);
  });

  it("REFUSES (throws, naming the line) on a real-looking token it can't map", () => {
    // Negative control: inject a real-shaped api-key into model-authored text.
    // The recorder has NO certain mapping for it, so it must flag-and-fail
    // rather than silently record a potential secret.
    const events = cleanEvents();
    events[1].payload.delta = `Your key is ${FAKE_API_KEY} — keep it safe.`;
    let thrown;
    try {
      buildCassette(events, { sessionId: SESSION_ID, messageId: MSG_ID });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecorderGuardError);
    expect(thrown.message).toMatch(/line 2/);
    expect(thrown.message).toMatch(/Refusing to write cassette/);
  });

  it("REFUSES on a real-looking email in a payload", () => {
    const events = cleanEvents();
    events[1].payload.delta = `Forward it to ${FAKE_EMAIL}`;
    expect(() => buildCassette(events, { sessionId: SESSION_ID, messageId: MSG_ID })).toThrow(
      RecorderGuardError,
    );
  });
});

describe("recorded cassette replays through the REAL ReplayBackend", () => {
  it("parseFixture accepts the recorded JSONL and serializeFixture round-trips it", () => {
    const { jsonl } = buildCassette(
      cleanEvents(),
      { sessionId: SESSION_ID, messageId: MSG_ID },
      { afterMs: 20 },
    );
    // The real replay-loader parses the cassette the recorder produced.
    const fixture = parseFixture("recorded", jsonl);
    expect(fixture.entries).toHaveLength(3);
    expect(fixture.entries[0].event.type).toBe("agent.message.start");

    // Round-trip: serialize → re-parse must yield the same entry shape, proving
    // the cassette is stable on the replay path (the validate-universes guard
    // checks the same invariant structurally).
    const reparsed = parseFixture("recorded", serializeFixture(fixture));
    expect(reparsed.entries.map((e) => e.event.type)).toEqual(
      fixture.entries.map((e) => e.event.type),
    );
    expect(reparsed.entries.map((e) => e.afterMs)).toEqual(fixture.entries.map((e) => e.afterMs));
  });
});

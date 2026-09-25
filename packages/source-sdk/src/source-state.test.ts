// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  encodeSourceState,
  isFreshStart,
  isStateEnvelope,
  resolveSourceState,
  stateOf,
  validateStateSpec,
  type SourceStateSpec,
} from "./source-state.js";

interface V3 extends Record<string, unknown> {
  after: string;
  seen: number;
}

const isV3 = (v: unknown): v is V3 =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as V3).after === "string" &&
  typeof (v as V3).seen === "number";

/** Three majors: v1 `{ cursor }`, v2 `{ after }`, v3 `{ after, seen }`. */
const spec: SourceStateSpec<V3> = {
  version: 3,
  minorVersion: 1,
  decode: (v) => (isV3(v) ? v : null),
  migrate: {
    1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }),
    2: (old) => ({ after: (old as { after?: string }).after ?? "", seen: 0 }),
  },
};

describe("state envelope", () => {
  test("an encoded envelope round-trips through resolve unchanged", () => {
    const state: V3 = { after: "2026-09-01", seen: 42 };
    const envelope = encodeSourceState(spec, state, { sourceId: "fieldnotes:local" });
    expect(envelope).toEqual({ e: 1, v: 3, m: 1, s: "fieldnotes:local", state });
    expect(isStateEnvelope(envelope)).toBe(true);

    const outcome = resolveSourceState(spec, envelope, { sourceId: "fieldnotes:local" });
    expect(outcome).toEqual({ kind: "resume", state, version: 3, minorVersion: 1 });
    expect(stateOf(outcome)).toEqual(state);
    expect(isFreshStart(outcome)).toBe(false);
  });

  test("a minor version omitted from the stored value still resumes", () => {
    // What an earlier minor of the same major wrote: no `m` on the envelope.
    const outcome = resolveSourceState(spec, { e: 1, v: 3, state: { after: "x", seen: 1 } });
    expect(outcome).toMatchObject({ kind: "resume", minorVersion: 0 });
  });

  test("an envelope written for another source is refused, never resumed", () => {
    const envelope = encodeSourceState(spec, { after: "x", seen: 1 }, { sourceId: "gmail:a" });
    const outcome = resolveSourceState(spec, envelope, { sourceId: "gmail:b" });
    expect(outcome).toMatchObject({ kind: "refused", storedVersion: 3 });
    expect(outcome.kind === "refused" && outcome.reason).toContain("gmail:a");
  });

  test("the envelope stays small: no source id when the host does not pass one", () => {
    expect(encodeSourceState(spec, { after: "x", seen: 0 })).toEqual({
      e: 1,
      v: 3,
      m: 1,
      state: { after: "x", seen: 0 },
    });
  });
});

describe("fresh starts", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
  ])("%s is a fresh start, not an unreadable state", (_label, stored) => {
    const outcome = resolveSourceState(spec, stored);
    expect(outcome).toEqual({ kind: "fresh" });
    expect(isFreshStart(outcome)).toBe(true);
    expect(stateOf(outcome)).toBeUndefined();
  });

  test("an empty object does not log a rebootstrap every run", () => {
    // Regression guard for the obvious implementation: `emptySync()` writes
    // `{}`, so treating it as undecodable would make quiet sources noisy.
    expect(resolveSourceState({ ...spec, onUnreadable: "stop" }, {})).toEqual({ kind: "fresh" });
  });
});

describe("migration chain", () => {
  test("a version 1 value migrates the whole way to the current version", () => {
    const outcome = resolveSourceState(spec, { e: 1, v: 1, state: { cursor: "abc" } });
    expect(outcome).toEqual({
      kind: "migrated",
      state: { after: "abc", seen: 0 },
      from: 1,
      to: 3,
    });
  });

  test("a version 2 value takes only the last hop", () => {
    const outcome = resolveSourceState(spec, { e: 1, v: 2, state: { after: "zz" } });
    expect(outcome).toEqual({ kind: "migrated", state: { after: "zz", seen: 0 }, from: 2, to: 3 });
  });

  test("a migration that returns null falls back to the unreadable policy", () => {
    const refusing: SourceStateSpec<V3> = {
      ...spec,
      migrate: { ...spec.migrate, 2: () => null },
    };
    expect(resolveSourceState(refusing, { e: 1, v: 2, state: { after: "z" } })).toMatchObject({
      kind: "rebootstrap",
    });
  });

  test("a migration that throws is caught and reported, never propagated", () => {
    const throwing: SourceStateSpec<V3> = {
      ...spec,
      migrate: {
        ...spec.migrate,
        2: () => {
          throw new Error("bad row");
        },
      },
    };
    const outcome = resolveSourceState(throwing, { e: 1, v: 2, state: { after: "z" } });
    expect(outcome).toMatchObject({ kind: "rebootstrap" });
    expect(outcome.kind === "rebootstrap" && outcome.reason).toContain("bad row");
  });

  test("a chain that produces a shape the current decoder rejects is a caught bug", () => {
    const buggy: SourceStateSpec<V3> = {
      ...spec,
      // Drops `seen`, so the v3 decoder rejects the result.
      migrate: { ...spec.migrate, 2: (old) => ({ after: (old as V3).after }) },
    };
    const outcome = resolveSourceState(buggy, { e: 1, v: 2, state: { after: "z" } });
    expect(outcome).toMatchObject({ kind: "rebootstrap" });
    expect(outcome.kind === "rebootstrap" && outcome.reason).toContain("decoder rejected");
  });
});

describe("legacy values written before envelopes existed", () => {
  test("an unwrapped value is version 1 by default", () => {
    expect(resolveSourceState(spec, { cursor: "legacy" })).toEqual({
      kind: "migrated",
      state: { after: "legacy", seen: 0 },
      from: 1,
      to: 3,
    });
  });

  test("a source that versioned its own cursor classifies it with legacyVersion", () => {
    const selfVersioned: SourceStateSpec<V3> = {
      ...spec,
      legacyVersion: (v) => ((v as { version?: number }).version === 2 ? 2 : 1),
    };
    const outcome = resolveSourceState(selfVersioned, { version: 2, after: "kept" });
    expect(outcome).toEqual({
      kind: "migrated",
      state: { after: "kept", seen: 0 },
      from: 2,
      to: 3,
    });
  });

  test("legacyVersion returning null falls back to the unreadable policy", () => {
    const picky: SourceStateSpec<V3> = { ...spec, legacyVersion: () => null };
    expect(resolveSourceState(picky, { junk: true })).toMatchObject({ kind: "rebootstrap" });
  });
});

describe("state this build cannot read", () => {
  test("a newer version is refused and the stored value is left intact", () => {
    const outcome = resolveSourceState(spec, { e: 1, v: 9, state: { whatever: true } });
    expect(outcome).toMatchObject({ kind: "refused", storedVersion: 9 });
    expect(outcome.kind === "refused" && outcome.reason).toContain("newer than this build");
  });

  test("a newer version is refused even when the policy says rebootstrap", () => {
    // The policy governs unreadable state, not a downgrade. Starting over here
    // would overwrite state the newer build understands.
    const outcome = resolveSourceState(
      { ...spec, onUnreadable: "rebootstrap" },
      { e: 1, v: 9, state: {} },
    );
    expect(outcome.kind).toBe("refused");
  });

  test("onUnreadable defaults to rebootstrap", () => {
    expect(resolveSourceState(spec, { e: 1, v: 3, state: { wrong: true } })).toMatchObject({
      kind: "rebootstrap",
    });
  });

  test("onUnreadable stop refuses instead, for a source whose history cannot be re-fetched", () => {
    const outcome = resolveSourceState(
      { ...spec, onUnreadable: "stop" },
      { e: 1, v: 3, state: { wrong: true } },
    );
    expect(outcome).toMatchObject({ kind: "refused", storedVersion: 3 });
  });

  test.each([
    ["a string", "not-an-object"],
    ["a number", 7],
  ])("%s stored where an object belongs is reported, not thrown", (_label, stored) => {
    expect(resolveSourceState(spec, stored)).toMatchObject({ kind: "rebootstrap" });
  });

  test("a non-integer version is reported rather than trusted", () => {
    expect(resolveSourceState(spec, { e: 1, v: 1.5, state: {} })).toMatchObject({
      kind: "rebootstrap",
    });
  });
});

describe("validateStateSpec", () => {
  test("accepts a complete chain", () => {
    expect(() => validateStateSpec(spec, "defineSource('x')")).not.toThrow();
  });

  test("accepts version 1 with no migrations at all", () => {
    expect(() =>
      validateStateSpec({ version: 1, decode: (v) => v as V3 }, "defineSource('x')"),
    ).not.toThrow();
  });

  test("rejects a hole in the chain, naming the missing version", () => {
    const holed: SourceStateSpec<V3> = { ...spec, migrate: { 2: spec.migrate![2] } };
    expect(() => validateStateSpec(holed, "defineSource('x')")).toThrow(
      /no migration from version 1/,
    );
  });

  test("rejects a migration keyed at or above the current version", () => {
    const stray: SourceStateSpec<V3> = {
      ...spec,
      migrate: { ...spec.migrate, 3: (v) => v },
    };
    expect(() => validateStateSpec(stray, "defineSource('x')")).toThrow(/not below state.version/);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s version", (_label, version) => {
    expect(() =>
      validateStateSpec({ version, decode: (v) => v as V3 }, "defineSource('x')"),
    ).toThrow(/state.version must be an integer/);
  });

  test("rejects a fractional minor version", () => {
    expect(() =>
      validateStateSpec(
        { version: 1, minorVersion: 0.5, decode: (v) => v as V3 },
        "defineSource('x')",
      ),
    ).toThrow(/state.minorVersion/);
  });

  test("rejects a missing decoder", () => {
    expect(() =>
      validateStateSpec({ version: 1 } as unknown as SourceStateSpec, "defineSource('x')"),
    ).toThrow(/state.decode/);
  });
});

describe("the property that motivates the whole mechanism", () => {
  test("an old value never silently becomes a full replay", () => {
    // Before this existed, every one of these produced the same `null` a
    // first-ever run produces, and so the same full re-read of upstream.
    const cases: unknown[] = [
      { cursor: "v1" }, //            older release
      { e: 1, v: 2, state: { after: "x" } }, // older release, enveloped
      { e: 1, v: 3, state: { corrupt: true } }, // corrupted
      { e: 1, v: 9, state: {} }, //   newer release
    ];
    const outcomes = cases.map((c) => resolveSourceState(spec, c).kind);
    expect(outcomes).toEqual(["migrated", "migrated", "rebootstrap", "refused"]);
    // A genuine first run is the only "fresh".
    expect(resolveSourceState(spec, null).kind).toBe("fresh");
  });
});

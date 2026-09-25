// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach } from "vitest";
import { readImpairment, impairEntries, impairedSnapshot, impairedIds } from "./impairment.js";

const ENV = "OMNESIS_SYNTH_READ_IMPAIRMENT";

afterEach(() => {
  delete process.env[ENV];
});

describe("synthetic read impairment", () => {
  test("no rule means a healthy source", () => {
    expect(readImpairment("things:local")).toBeNull();
    expect(impairEntries([1, 2, 3], "things:local")).toEqual({
      visible: [1, 2, 3],
      snapshotAllowed: true,
    });
  });

  test("a rule matching a source id that contains colons", () => {
    process.env[ENV] = "things:local:degraded:2";
    expect(readImpairment("things:local")).toEqual({ mode: "degraded", hide: 2 });
    expect(readImpairment("gmail:someone@example.com")).toBeNull();
  });

  test("`*` matches every source, including a caller that supplies no id", () => {
    process.env[ENV] = "*:degraded:1";
    expect(readImpairment("anything:at:all")).toEqual({ mode: "degraded", hide: 1 });
    expect(readImpairment(undefined)).toEqual({ mode: "degraded", hide: 1 });
  });

  test("a named rule does not reach a source that only a `*` rule would", () => {
    process.env[ENV] = "things:degraded:1";
    expect(readImpairment(undefined)).toBeNull();
  });

  test("degraded hides entries AND withholds the snapshot", () => {
    process.env[ENV] = "things:degraded:2";
    expect(impairEntries(["a", "b", "c", "d"], "things:local")).toEqual({
      visible: ["a", "b"],
      snapshotAllowed: false,
    });
  });

  test("deleted hides the same entries but still vouches for the enumeration", () => {
    process.env[ENV] = "things:deleted:2";
    expect(impairEntries(["a", "b", "c", "d"], "things:local")).toEqual({
      visible: ["a", "b"],
      snapshotAllowed: true,
    });
  });

  test("the count defaults to one when omitted", () => {
    process.env[ENV] = "things:degraded";
    expect(readImpairment("things:local")).toEqual({ mode: "degraded", hide: 1 });
  });

  test("hiding more than the source holds leaves nothing visible", () => {
    process.env[ENV] = "*:degraded:9";
    expect(impairEntries(["a"], "things:local")).toEqual({ visible: [], snapshotAllowed: false });
  });

  test("several rules are tried in order and an unknown mode is ignored", () => {
    process.env[ENV] = "gmail:bogus:1,things:deleted:3";
    expect(readImpairment("things:local")).toEqual({ mode: "deleted", hide: 3 });
    expect(readImpairment("gmail:x")).toBeNull();
  });

  test("impairedIds names the records the read could not see", () => {
    process.env[ENV] = "things:degraded:2";
    impairEntries(["a", "b", "c", "d"], "things:local", (e) => e);

    // Identities, not a count: a test asserting `length === 2` cannot tell the
    // right two survivors from any two.
    expect(impairedIds("things:local")).toEqual(["c", "d"]);
  });

  test("impairedIds is reported for `deleted` as well as `degraded`", () => {
    process.env[ENV] = "things:deleted:1";
    impairedSnapshot([{ id: "x" }, { id: "y" }], "things:local", (e) => e.id);
    expect(impairedIds("things:local")).toEqual(["y"]);
  });

  test("a repaired read reports an empty set, not the previous cycle's", () => {
    process.env[ENV] = "things:degraded:2";
    impairEntries(["a", "b", "c"], "things:local", (e) => e);
    expect(impairedIds("things:local")).toEqual(["b", "c"]);

    delete process.env[ENV];
    impairEntries(["a", "b", "c"], "things:local", (e) => e);
    expect(
      impairedIds("things:local"),
      "a stale hidden set would mislead the next assertion",
    ).toEqual([]);
  });

  test("a source that never ran reports nothing", () => {
    expect(impairedIds("never-synced:source")).toEqual([]);
  });

  test("the returned array cannot be mutated into the record", () => {
    process.env[ENV] = "things:degraded:1";
    impairEntries(["a", "b"], "things:local", (e) => e);
    impairedIds("things:local").push("injected");
    expect(impairedIds("things:local")).toEqual(["b"]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the sweep file grammar. Every rejection here is something an
 * author will eventually type, and the point of a strict parser is that they
 * are told rather than left with a sweep that quietly never runs.
 */

import { describe, test, expect } from "vitest";
import {
  isValidSweepId,
  MAX_STEERING_PROMPT_CHARS,
  parseSweepFile,
  serializeSweepFile,
} from "./file-format.js";

const ok = (text: string) => {
  const r = parseSweepFile(text);
  if (!r.ok) throw new Error(`expected a parse, got: ${r.message}`);
  return r.content;
};
const err = (text: string) => {
  const r = parseSweepFile(text);
  if (r.ok) throw new Error("expected a rejection");
  return r.message;
};

describe("isValidSweepId", () => {
  test("accepts filename-safe kebab ids and rejects anything else", () => {
    for (const good of ["a", "commitments-made", "sweep-2", "x".repeat(64)]) {
      expect(isValidSweepId(good)).toBe(true);
    }
    for (const bad of [
      "",
      "-leading",
      "Upper",
      "with space",
      "with_underscore",
      "../escape",
      "dir/sub",
      "x".repeat(65),
    ]) {
      expect(isValidSweepId(bad)).toBe(false);
    }
  });
});

describe("parseSweepFile", () => {
  test("reads front matter and body", () => {
    const c = ok(
      [
        "---",
        "name: Commitments I made",
        "cadence: 7d",
        'at: "06:30"',
        "enabled: true",
        "primeHorizonDays: 14",
        "---",
        "",
        "Look for promises the user made.",
        "",
      ].join("\n"),
    );
    expect(c).toEqual({
      name: "Commitments I made",
      cadenceHours: 168,
      anchorMinutes: 390,
      enabled: true,
      temporalAnnotationPrimeDays: 14,
      steeringPrompt: "Look for promises the user made.",
    });
  });

  test("front matter is optional — a bare prose file is a valid sweep body", () => {
    expect(ok("Just the prose.\n")).toEqual({ steeringPrompt: "Just the prose." });
  });

  test("a front-matter-only file is valid — it is how a built-in is silenced", () => {
    expect(ok("---\nenabled: false\n---\n")).toEqual({ enabled: false, steeringPrompt: "" });
  });

  test("CRLF and comments are tolerated", () => {
    const c = ok("---\r\n# why this exists\r\ncadence: 30d\r\n---\r\n\r\nProse.\r\n");
    expect(c.cadenceHours).toBe(720);
    expect(c.steeringPrompt).toBe("Prose.");
  });

  test("cadence accepts duration units and rejects nonsense or a too-dense value", () => {
    expect(ok("---\ncadence: 24h\n---\nx").cadenceHours).toBe(24);
    expect(ok("---\ncadence: 1d\n---\nx").cadenceHours).toBe(24);
    expect(err("---\ncadence: weekly\n---\nx")).toMatch(/not a duration/);
    // A day is the floor: a sweep has one boundary per day, so anything
    // denser cannot be expressed — and belongs in a watch anyway.
    expect(err("---\ncadence: 6h\n---\nx")).toMatch(/at least 24h/);
    expect(err("---\ncadence: 5m\n---\nx")).toMatch(/at least 24h/);
    expect(err("---\ncadence: 2y\n---\nx")).toMatch(/at most a year/);
  });

  test("rejects an unclosed fence, an unknown key, a duplicate key, and malformed values", () => {
    expect(err("---\ncadence: 7d\n\nProse with no closing fence")).toMatch(/never closed/);
    expect(err("---\ncadance: 7d\n---\nx")).toMatch(/unknown front-matter key/);
    expect(err("---\ncadence: 7d\ncadence: 8d\n---\nx")).toMatch(/appears twice/);
    expect(err("---\nnot a pair\n---\nx")).toMatch(/not `key: value`/);
    expect(err('---\nat: "25:00"\n---\nx')).toMatch(/24-hour local time/);
    expect(err("---\nenabled: yes\n---\nx")).toMatch(/must be true or false/);
    expect(err("---\nprimeHorizonDays: -1\n---\nx")).toMatch(/whole number of days/);
    expect(err("---\nname:\n---\nx")).toMatch(/`name` is empty/);
  });

  test("caps the steering prose", () => {
    expect(err("x".repeat(MAX_STEERING_PROMPT_CHARS + 1))).toMatch(/the limit is/);
  });

  test("round-trips through serializeSweepFile", () => {
    const content = {
      name: "Trip readiness",
      cadenceHours: 168,
      anchorMinutes: 545,
      enabled: false,
      temporalAnnotationPrimeDays: 21,
      steeringPrompt: "When a trip is coming, what is still unbooked?",
    };
    expect(ok(serializeSweepFile(content))).toEqual(content);
  });

  test("serializes whole days as days, so a hand-edited file reads naturally", () => {
    expect(serializeSweepFile({ cadenceHours: 168, steeringPrompt: "x" })).toContain("cadence: 7d");
    expect(serializeSweepFile({ cadenceHours: 36, steeringPrompt: "x" })).toContain("cadence: 36h");
  });

  test("omits every absent field, so a minimal file stays minimal", () => {
    expect(serializeSweepFile({ enabled: false, steeringPrompt: "" })).toBe(
      "---\nenabled: false\n---\n",
    );
  });
});

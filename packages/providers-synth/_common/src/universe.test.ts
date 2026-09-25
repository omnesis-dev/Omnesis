// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UniverseError,
  getAgentDemosDir,
  getUniversesDir,
  hostingDeviceKinds,
  loadActiveUniverse,
  loadCastFromUniverse,
  loadSourceFixtureJson,
  loadUniverse,
  resetActiveUniverseCache,
  sourceDeviceAssignments,
  sourceHostAssignments,
  validateUniverse,
} from "./universe.js";
import type { Universe } from "./universe.js";

const SAVED_ENV = process.env.OMNESIS_SYNTH_UNIVERSE;

beforeEach(() => {
  delete process.env.OMNESIS_SYNTH_UNIVERSE;
  resetActiveUniverseCache();
});

afterEach(() => {
  if (SAVED_ENV !== undefined) process.env.OMNESIS_SYNTH_UNIVERSE = SAVED_ENV;
  else delete process.env.OMNESIS_SYNTH_UNIVERSE;
  resetActiveUniverseCache();
});

describe("universe loader — repo-root resolution", () => {
  it("finds evals/universes via walk-up from this module", () => {
    const dir = getUniversesDir();
    expect(dir).toMatch(/evals\/universes$/);
  });
});

describe("universe loader — name resolution", () => {
  it("loads the built-in `default` universe by name", () => {
    const u = loadUniverse("default");
    expect(u.manifest.name).toBe("default");
    expect(u.manifest.sources.length).toBeGreaterThan(0);
    expect(u.dir).toMatch(/evals\/universes\/default$/);
  });

  it("falls back to `default` when OMNESIS_SYNTH_UNIVERSE is unset", () => {
    const u = loadActiveUniverse();
    expect(u.manifest.name).toBe("default");
  });

  it("honors OMNESIS_SYNTH_UNIVERSE when set to a name", () => {
    process.env.OMNESIS_SYNTH_UNIVERSE = "default";
    resetActiveUniverseCache();
    const u = loadActiveUniverse();
    expect(u.manifest.name).toBe("default");
  });

  it("throws a UniverseError for an unknown name", () => {
    expect(() => loadUniverse("does-not-exist-xyz")).toThrowError(UniverseError);
    expect(() => loadUniverse("does-not-exist-xyz")).toThrowError(/not found/i);
  });
});

describe("universe loader — path resolution", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("treats a string with a slash as a filesystem path", () => {
    const dir = join(tmp, "tiny-universe");
    mkdirSync(join(dir, "sources", "gmail"), { recursive: true });
    writeFileSync(
      join(dir, "universe.json"),
      JSON.stringify({
        name: "tiny",
        cast: "cast.json",
        devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
        sources: [{ descriptorId: "gmail", accountIds: ["a@example.com"], device: "laptop" }],
      }),
    );
    writeFileSync(
      join(dir, "cast.json"),
      JSON.stringify({ self: "p_a", people: [{ id: "p_a", name: "Anya Example" }] }),
    );
    writeFileSync(join(dir, "sources", "gmail", "messages.json"), "[]");

    const u = loadUniverse(dir);
    expect(u.manifest.name).toBe("tiny");
    expect(u.dir).toBe(dir);
  });
});

describe("universe loader — manifest validation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects a manifest missing required fields", () => {
    writeFileSync(join(tmp, "universe.json"), JSON.stringify({ name: "bad" }));
    expect(() => loadUniverse(tmp)).toThrowError(/cast/i);
  });

  it("rejects a manifest with non-array sources", () => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({
        name: "bad",
        cast: "cast.json",
        devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
        sources: "not-an-array",
      }),
    );
    expect(() => loadUniverse(tmp)).toThrowError(/sources/i);
  });

  it("rejects an entry without accountIds", () => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({
        name: "bad",
        cast: "cast.json",
        devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
        sources: [{ descriptorId: "gmail" }],
      }),
    );
    expect(() => loadUniverse(tmp)).toThrowError(/accountIds/i);
  });

  it("rejects a manifest without a roster", () => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({
        name: "bad",
        cast: "cast.json",
        sources: [
          { descriptorId: "gmail", accountIds: ["maya.reeves@example.com"], device: "laptop" },
        ],
      }),
    );
    expect(() => loadUniverse(tmp)).toThrowError(/'devices' must be a non-empty array/);
  });

  const laptop = { id: "laptop", name: "Mayas-laptop", kind: "collector" };
  it.each([
    ["a non-object device", [42], /devices\[0\] must be an object/],
    ["an empty device id", [{ ...laptop, id: "" }], /devices\[0\]\.id/],
    ["an empty device name", [{ ...laptop, name: "" }], /devices\[0\]\.name/],
    ["an unknown device kind", [{ ...laptop, kind: "toaster" }], /devices\[0\]\.kind/],
    ["a kind that hosts nothing", [{ ...laptop, kind: "portal" }], /devices\[0\]\.kind/],
  ])("rejects %s", (_label, devices, expected) => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({
        name: "bad",
        cast: "cast.json",
        devices,
        sources: [
          { descriptorId: "gmail", accountIds: ["maya.reeves@example.com"], device: "laptop" },
        ],
      }),
    );
    expect(() => loadUniverse(tmp)).toThrowError(expected);
  });

  it.each([
    ["a source without a device", { descriptorId: "gmail", accountIds: ["a@example.com"] }],
    [
      "a source naming a device outside the roster",
      { descriptorId: "gmail", accountIds: ["a@example.com"], device: "ghost" },
    ],
  ])("rejects %s", (_label, source) => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({ name: "bad", cast: "cast.json", devices: [laptop], sources: [source] }),
    );
    expect(() => loadUniverse(tmp)).toThrowError(/sources\[0\]\.device must name a device/);
  });
});

describe("universe validator — device roster", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    mkdirSync(join(tmp, "sources", "gmail"), { recursive: true });
    mkdirSync(join(tmp, "sources", "apple-health"), { recursive: true });
    writeFileSync(join(tmp, "sources", "gmail", "messages.json"), "[]");
    writeFileSync(join(tmp, "sources", "apple-health", "samples.json"), "[]");
    writeFileSync(
      join(tmp, "cast.json"),
      JSON.stringify({
        self: "p_a",
        people: [{ id: "p_a", name: "Maya Reeves", emails: ["maya.reeves@example.com"] }],
        orgs: [],
      }),
    );
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const manifest = (
    devices: unknown[],
    sources: unknown[],
  ): ReturnType<typeof validateUniverse> => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({ name: "roster", cast: "cast.json", devices, sources }),
    );
    return validateUniverse(loadUniverse(tmp));
  };
  const errors = (issues: ReturnType<typeof validateUniverse>) =>
    issues.filter((i) => i.severity === "error").map((i) => i.message);

  it("accepts a phone-pushed type on a phone and a polled type on a collector", () => {
    const issues = manifest(
      [
        { id: "laptop", name: "Mayas-laptop", kind: "collector" },
        { id: "phone", name: "Mayas-iPhone", kind: "ios" },
      ],
      [
        { descriptorId: "gmail", accountIds: ["maya.reeves@example.com"], device: "laptop" },
        { descriptorId: "apple-health", accountIds: ["ios-synth-maya"], device: "phone" },
      ],
    );
    expect(errors(issues)).toEqual([]);
    expect(issues.filter((i) => i.severity === "warn")).toEqual([]);
  });

  it("refuses a phone type on a collector or the wrong phone, and a polled type on a phone", () => {
    const issues = manifest(
      [
        { id: "laptop", name: "Mayas-laptop", kind: "collector" },
        { id: "phone", name: "Mayas-iPhone", kind: "ios" },
        { id: "pixel", name: "Mayas-Android", kind: "android" },
      ],
      [
        { descriptorId: "gmail", accountIds: ["maya.reeves@example.com"], device: "phone" },
        { descriptorId: "apple-health", accountIds: ["ios-synth-maya"], device: "laptop" },
        { descriptorId: "apple-health", accountIds: ["ios-synth-other"], device: "pixel" },
      ],
    );
    expect(errors(issues)).toEqual([
      expect.stringMatching(/"gmail" is synced by a collector; "phone" has kind ios/),
      expect.stringMatching(/"apple-health" is pushed by ios devices; "laptop" has kind collector/),
      expect.stringMatching(/"apple-health" is pushed by ios devices; "pixel" has kind android/),
    ]);
  });

  it("refuses duplicate roster ids and names, and flags an idle device", () => {
    const issues = manifest(
      [
        { id: "laptop", name: "Mayas-laptop", kind: "collector" },
        { id: "laptop", name: "Mayas-laptop", kind: "collector" },
        { id: "phone", name: "Mayas-iPhone", kind: "ios" },
      ],
      [{ descriptorId: "gmail", accountIds: ["maya.reeves@example.com"], device: "laptop" }],
    );
    expect(errors(issues)).toEqual([
      expect.stringMatching(/duplicate roster id "laptop"/),
      expect.stringMatching(/duplicate device name "Mayas-laptop"/),
    ]);
    expect(issues.filter((i) => i.severity === "warn").map((i) => i.where)).toEqual([
      "devices[2] (phone)",
    ]);
  });

  it("maps every seed source to its roster device", () => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({
        name: "roster",
        cast: "cast.json",
        devices: [
          { id: "laptop", name: "Mayas-laptop", kind: "collector" },
          { id: "phone", name: "Mayas-iPhone", kind: "ios" },
        ],
        sources: [
          {
            descriptorId: "gmail",
            accountIds: ["a@example.com", "b@example.com"],
            device: "laptop",
          },
          { descriptorId: "apple-health", accountIds: ["ios-synth-maya"], device: "phone" },
        ],
      }),
    );
    const assignments = sourceDeviceAssignments(loadUniverse(tmp).manifest);
    expect([...assignments.entries()].map(([id, d]) => [id, d.id])).toEqual([
      ["gmail:a@example.com", "laptop"],
      ["gmail:b@example.com", "laptop"],
      ["apple-health:ios-synth-maya", "phone"],
    ]);
    expect(hostingDeviceKinds("photos").sort()).toEqual(["android", "ios"]);
    expect(hostingDeviceKinds("gmail")).toEqual([]);
  });
});

describe("universe manifest — members and multi-device modes", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    mkdirSync(join(tmp, "sources", "apple-notes"), { recursive: true });
    mkdirSync(join(tmp, "sources", "apple-health"), { recursive: true });
    writeFileSync(join(tmp, "sources", "apple-notes", "notes.json"), "[]");
    writeFileSync(join(tmp, "sources", "apple-health", "samples.json"), "[]");
    writeFileSync(
      join(tmp, "cast.json"),
      JSON.stringify({
        self: "p_a",
        people: [{ id: "p_a", name: "Maya Reeves", emails: ["maya.reeves@example.com"] }],
        orgs: [],
      }),
    );
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const DEVICES = [
    { id: "laptop", name: "Mayas-laptop", kind: "collector" },
    { id: "desktop", name: "Mayas-desktop", kind: "collector" },
    { id: "phone", name: "Mayas-iPhone", kind: "ios" },
    { id: "tablet", name: "Mayas-iPad", kind: "ios" },
  ];
  const write = (manifest: Record<string, unknown>) =>
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({ name: "modes", cast: "cast.json", devices: DEVICES, ...manifest }),
    );
  const errors = (issues: ReturnType<typeof validateUniverse>) =>
    issues.filter((i) => i.severity === "error").map((i) => i.message);

  it("parses members and modes, and lists every host of a source owner-first", () => {
    write({
      multiDeviceModes: { "apple-notes": "replicated", "apple-health": "replicated" },
      sources: [
        {
          descriptorId: "apple-notes",
          accountIds: ["maya.reeves@example.com"],
          device: "laptop",
          members: ["desktop"],
        },
        {
          descriptorId: "apple-health",
          accountIds: ["ios-synth-maya"],
          device: "phone",
          members: ["tablet"],
        },
      ],
    });
    const universe = loadUniverse(tmp);
    expect(universe.manifest.multiDeviceModes).toEqual({
      "apple-notes": "replicated",
      "apple-health": "replicated",
    });
    const hosts = sourceHostAssignments(universe.manifest);
    expect(hosts.get("apple-notes:maya.reeves@example.com")?.map((d) => d.id)).toEqual([
      "laptop",
      "desktop",
    ]);
    expect(hosts.get("apple-health:ios-synth-maya")?.map((d) => d.id)).toEqual(["phone", "tablet"]);
    // The owner assignment is unchanged by members.
    expect(
      sourceDeviceAssignments(universe.manifest).get("apple-notes:maya.reeves@example.com")?.id,
    ).toBe("laptop");
    expect(errors(validateUniverse(universe))).toEqual([]);
    expect(validateUniverse(universe).filter((i) => i.severity === "warn")).toEqual([]);
  });

  it("refuses a member outside the roster, the owner repeated as a member, and a member listed twice", () => {
    const source = (members: string[]) => ({
      multiDeviceModes: { "apple-notes": "replicated" },
      sources: [
        {
          descriptorId: "apple-notes",
          accountIds: ["maya.reeves@example.com"],
          device: "laptop",
          members,
        },
      ],
    });
    write(source(["nobody"]));
    expect(() => loadUniverse(tmp)).toThrowError(/members\[0\] must name a device/);
    write(source(["laptop"]));
    expect(() => loadUniverse(tmp)).toThrowError(/repeats the owner/);
    write(source(["desktop", "desktop"]));
    expect(() => loadUniverse(tmp)).toThrowError(/lists a device twice/);
  });

  it("refuses an unknown or exclusive mode", () => {
    const sources = [
      { descriptorId: "apple-notes", accountIds: ["maya.reeves@example.com"], device: "laptop" },
    ];
    write({ multiDeviceModes: { "apple-notes": "shared" }, sources });
    expect(() => loadUniverse(tmp)).toThrowError(/handoff, replicated, partitioned/);
    write({ multiDeviceModes: { "apple-notes": "exclusive" }, sources });
    expect(() => loadUniverse(tmp)).toThrowError(/handoff, replicated, partitioned/);
  });

  it("flags a mode on a roster with no collector to announce it", () => {
    writeFileSync(
      join(tmp, "universe.json"),
      JSON.stringify({
        name: "phones-only",
        cast: "cast.json",
        devices: [
          { id: "phone", name: "Mayas-iPhone", kind: "ios" },
          { id: "tablet", name: "Mayas-iPad", kind: "ios" },
        ],
        multiDeviceModes: { "apple-health": "replicated" },
        sources: [
          {
            descriptorId: "apple-health",
            accountIds: ["ios-synth-maya"],
            device: "phone",
            members: ["tablet"],
          },
        ],
      }),
    );
    expect(errors(validateUniverse(loadUniverse(tmp)))).toEqual([
      expect.stringMatching(/announced to the gateway by a collector/),
    ]);
  });

  it("flags members on an exclusive source, a member of the wrong kind, and a mode nothing seeds", () => {
    write({
      multiDeviceModes: { "apple-health": "replicated", gmail: "handoff" },
      sources: [
        {
          descriptorId: "apple-notes",
          accountIds: ["maya.reeves@example.com"],
          device: "laptop",
          members: ["desktop"],
        },
        {
          descriptorId: "apple-health",
          accountIds: ["ios-synth-maya"],
          device: "phone",
          members: ["desktop"],
        },
      ],
    });
    const issues = validateUniverse(loadUniverse(tmp));
    expect(errors(issues)).toEqual([
      expect.stringMatching(/apple-notes.*lists members but has no non-exclusive entry/),
      expect.stringMatching(/apple-health.*is pushed by ios devices; "desktop" has kind collector/),
    ]);
    // The unseeded mode is flagged; so is the tablet nothing attributes to.
    expect(issues.filter((i) => i.severity === "warn").map((i) => i.where)).toEqual([
      'multiDeviceModes["gmail"]',
      "devices[3] (tablet)",
    ]);
  });
});

describe("universe loader — fixture readers", () => {
  it("loads a known source fixture from the default universe", () => {
    const u = loadUniverse("default");
    const emails = loadSourceFixtureJson<{ externalId: string }[]>(u, "gmail", "messages.json");
    expect(Array.isArray(emails)).toBe(true);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0]).toHaveProperty("externalId");
  });

  it("throws a clear error for a missing fixture file", () => {
    const u = loadUniverse("default");
    expect(() => loadSourceFixtureJson(u, "gmail", "does-not-exist.json")).toThrowError(
      /missing fixture/i,
    );
  });

  it("loads the cast from the default universe", () => {
    const u = loadUniverse("default");
    const cast = loadCastFromUniverse(u);
    expect(cast.self.length).toBeGreaterThan(0);
    expect(cast.people.length).toBeGreaterThan(0);
    expect(cast.people.find((p) => p.id === cast.self)).toBeDefined();
  });

  it("getAgentDemosDir returns a path when the manifest declares one", () => {
    const u = loadUniverse("default");
    const dir = getAgentDemosDir(u);
    expect(dir).not.toBeNull();
    expect(dir).toMatch(/agent-demos$/);
  });
});

describe("e2e-minimal universe (built-in)", () => {
  it("loads via the same loader as default", () => {
    const u = loadUniverse("e2e-minimal");
    expect(u.manifest.name).toBe("e2e-minimal");
    expect(u.manifest.agentDemos).toBeNull();
    // Same source descriptors as the default universe — minimality comes from
    // per-source fixture shrink, not from dropping sources. Asserted as set
    // equality rather than a count, so adding a source to both universes stays
    // green while adding it to only one (the actual bug) reddens.
    const ids = (uni: Universe) => uni.manifest.sources.map((s) => s.descriptorId).sort();
    expect(ids(u)).toEqual(ids(loadUniverse("default")));
  });

  it("is internally consistent (validator-clean)", () => {
    const u = loadUniverse("e2e-minimal");
    const issues = validateUniverse(u);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("stays small — unstructured sources cap at 3 entries", () => {
    const u = loadUniverse("e2e-minimal");
    // Regression net: if a future edit balloons one of these fixtures,
    // CI tells us before the "fast lane" stops being fast.
    const samples: Array<[string, string]> = [
      ["gmail", "messages.json"],
      ["google-calendar", "events.json"],
      ["apple-notes", "notes.json"],
      ["apple-calendar", "events.json"],
      ["outlook-calendar", "events.json"],
      ["core-location-visits", "visits.json"],
      ["notion-pages", "pages.json"],
      ["whatsapp-messages", "messages.json"],
    ];
    for (const [key, file] of samples) {
      const entries = loadSourceFixtureJson<unknown[]>(u, key, file);
      expect(entries.length, `${key}/${file} should be ≤ 3`).toBeLessThanOrEqual(3);
    }
  });
});

/**
 * Write a minimal, otherwise-clean universe carrying one agent-demo cassette
 * built from `events`, so a validator test can isolate what the cassette itself
 * is being checked for. Fixture data is invented.
 */
function writeUniverseWithDemo(dir: string, events: unknown[], meta?: unknown): void {
  mkdirSync(join(dir, "sources", "gmail"), { recursive: true });
  writeFileSync(
    join(dir, "sources", "gmail", "messages.json"),
    JSON.stringify([{ from: "maya.reeves@example.com", subject: "Quarterly budget review" }]),
  );
  writeFileSync(
    join(dir, "universe.json"),
    JSON.stringify({
      name: "demo-protocol",
      cast: "cast.json",
      agentDemos: "agent-demos",
      devices: [{ id: "laptop", name: "Mayas-laptop", kind: "collector" }],
      sources: [
        { descriptorId: "gmail", accountIds: ["maya.reeves@example.com"], device: "laptop" },
      ],
    }),
  );
  writeFileSync(
    join(dir, "cast.json"),
    JSON.stringify({
      self: "p_a",
      people: [{ id: "p_a", name: "Maya Reeves", emails: ["maya.reeves@example.com"] }],
      orgs: [],
    }),
  );
  mkdirSync(join(dir, "agent-demos"), { recursive: true });
  writeFileSync(
    join(dir, "agent-demos", "budget.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "agent-demos", "budget.meta.json"),
    JSON.stringify(meta ?? { triggers: ["budget review"] }),
  );
}

describe("universe validator", () => {
  it("reports no issues for the built-in default universe", () => {
    const u = loadUniverse("default");
    const issues = validateUniverse(u);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  /**
   * A demo whose builder was never migrated to the batch tools regenerates a
   * cassette calling `search_documents` / `fetch_document` / `annotate` at the
   * top level — a transcript the live agent cannot produce, because those tools
   * are not model-visible. Round-trip validation passes it (the JSON is fine),
   * so this is the check that catches it.
   */
  /**
   * A cassette declares which inference role replays it. A role the gateway
   * never builds a replay backend for would leave the scenario unreachable and
   * say nothing about it, so a wrong role is an error rather than a warning.
   */
  /**
   * A live-tool cassette threads gateway-minted ids through `$CAP_` refs. Both
   * ways that breaks are silent at replay time — an unresolved ref is passed to
   * a real tool as the literal placeholder — so the validator is where they must
   * surface.
   */
  describe("live-result captures", () => {
    const toolStart = (toolCallId: string, tool: string, args: Record<string, unknown>) => ({
      type: "agent.tool.start",
      payload: { sessionId: "$SESSION", messageId: "$MSG", toolCallId, tool, args },
    });
    const messageEnd = {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
    };
    const captureErrors = (events: unknown[]): string[] => {
      const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
      try {
        writeUniverseWithDemo(tmp, events);
        return validateUniverse(loadUniverse(tmp))
          .filter((i) => i.severity === "error")
          .map((i) => i.message);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    it("accepts a reference to a value an earlier entry captured", () => {
      expect(
        captureErrors([
          {
            afterMs: 0,
            event: toolStart("t1", "open_loop_create", { title: "x" }),
            capture: { loop1: "data.loop.id" },
          },
          { afterMs: 0, event: toolStart("t2", "open_loop_ledger_append", { id: "$CAP_loop1" }) },
          { afterMs: 0, event: messageEnd },
        ]),
      ).toEqual([]);
    });

    it("rejects a reference nothing ever captures", () => {
      expect(
        captureErrors([
          { afterMs: 0, event: toolStart("t2", "open_loop_ledger_append", { id: "$CAP_loop1" }) },
          { afterMs: 0, event: messageEnd },
        ]),
      ).toContainEqual(
        expect.stringContaining("references $CAP_loop1, which no earlier entry captures"),
      );
    });

    it("rejects a reference that precedes its capture", () => {
      expect(
        captureErrors([
          { afterMs: 0, event: toolStart("t2", "open_loop_ledger_append", { id: "$CAP_loop1" }) },
          {
            afterMs: 0,
            event: toolStart("t1", "open_loop_create", { title: "x" }),
            capture: { loop1: "data.loop.id" },
          },
          { afterMs: 0, event: messageEnd },
        ]),
      ).toContainEqual(
        expect.stringContaining("references $CAP_loop1, which no earlier entry captures"),
      );
    });

    it("rejects a capture on a call whose result is recorded, since it never runs live", () => {
      expect(
        captureErrors([
          {
            afterMs: 0,
            event: toolStart("t1", "open_loop_create", { title: "x" }),
            capture: { loop1: "data.loop.id" },
          },
          {
            afterMs: 0,
            event: {
              type: "agent.tool.result",
              payload: {
                sessionId: "$SESSION",
                messageId: "$MSG",
                toolCallId: "t1",
                durationMs: 1,
                result: { kind: "text", text: "recorded" },
              },
            },
          },
          { afterMs: 0, event: messageEnd },
        ]),
      ).toContainEqual(expect.stringContaining("never runs live"));
    });

    it("rejects a capture name the reference syntax cannot express", () => {
      // `$CAP_loop-1` reads as `$CAP_loop`, so the name would be captured
      // under one spelling and looked up under another.
      expect(
        captureErrors([
          {
            afterMs: 0,
            event: toolStart("t1", "open_loop_create", { title: "x" }),
            capture: { "loop-1": "data.loop.id" },
          },
          { afterMs: 0, event: messageEnd },
        ]),
      ).toContainEqual(expect.stringContaining("must match [A-Za-z0-9_]+"));
    });

    it("rejects a capture path that is not a non-empty string", () => {
      // Passing validate-universes but throwing at gateway boot is the exact
      // silent breakage this validator exists to prevent.
      expect(
        captureErrors([
          {
            afterMs: 0,
            event: toolStart("t1", "open_loop_create", { title: "x" }),
            capture: { loop1: 7 },
          },
          { afterMs: 0, event: messageEnd },
        ]),
      ).toContainEqual(expect.stringContaining("must be a non-empty path"));
    });

    it("rejects a capture declared on an event that is not a tool call", () => {
      expect(
        captureErrors([{ afterMs: 0, event: messageEnd, capture: { loop1: "data.loop.id" } }]),
      ).toContainEqual(expect.stringContaining("only a tool.start can capture"));
    });
  });

  it("rejects a cassette declaring a role no replay backend is built for", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      writeUniverseWithDemo(
        tmp,
        [
          {
            afterMs: 0,
            event: {
              type: "agent.message.end",
              payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
            },
          },
        ],
        { triggers: ["budget review"], role: "embedder" },
      );
      const errors = validateUniverse(loadUniverse(tmp)).filter((i) => i.severity === "error");
      expect(errors.map((e) => e.message)).toEqual([
        expect.stringMatching(/role must be omitted or one of/),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a cassette written for the privacy reviewer", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      writeUniverseWithDemo(
        tmp,
        [
          {
            afterMs: 0,
            event: {
              type: "agent.message.end",
              payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
            },
          },
        ],
        {
          triggers: ["budget review"],
          role: "privacy-reviewer",
        },
      );
      const errors = validateUniverse(loadUniverse(tmp)).filter((i) => i.severity === "error");
      expect(errors).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags a demo that calls a batch-wrapped tool at the top level", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      writeUniverseWithDemo(tmp, [
        {
          afterMs: 100,
          event: {
            type: "agent.tool.start",
            payload: {
              sessionId: "$SESSION",
              messageId: "$MSG",
              toolCallId: "tc_1",
              tool: "search_documents",
              args: { query: "quarterly budget review" },
            },
          },
        },
      ]);
      const errors = validateUniverse(loadUniverse(tmp)).filter((i) => i.severity === "error");
      expect(errors.map((e) => e.message)).toEqual([
        expect.stringMatching(/calls 'search_documents' at the top level/),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts the same tool on a per-child progress event", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      writeUniverseWithDemo(tmp, [
        {
          afterMs: 100,
          event: {
            type: "agent.tool.start",
            payload: {
              sessionId: "$SESSION",
              messageId: "$MSG",
              toolCallId: "tc_1",
              tool: "search_many",
              args: { queries: [{ query: "quarterly budget review" }] },
            },
          },
        },
        {
          afterMs: 40,
          event: {
            type: "agent.tool.child.start",
            payload: {
              sessionId: "$SESSION",
              messageId: "$MSG",
              toolCallId: "tc_1",
              childIndex: 0,
              tool: "search_documents",
              argsSummary: "quarterly budget review",
            },
          },
        },
      ]);
      expect(validateUniverse(loadUniverse(tmp)).filter((i) => i.severity === "error")).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags missing source fixture directories", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      writeFileSync(
        join(tmp, "universe.json"),
        JSON.stringify({
          name: "broken",
          cast: "cast.json",
          devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
          sources: [{ descriptorId: "gmail", accountIds: ["a@example.com"], device: "laptop" }],
        }),
      );
      writeFileSync(
        join(tmp, "cast.json"),
        JSON.stringify({ self: "p_a", people: [{ id: "p_a", name: "Anya" }] }),
      );
      const u = loadUniverse(tmp);
      const issues = validateUniverse(u);
      expect(issues.find((i) => i.where === "sources/gmail")).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags a cast.self that doesn't match any persona", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      mkdirSync(join(tmp, "sources", "gmail"), { recursive: true });
      writeFileSync(join(tmp, "sources", "gmail", "x.json"), "[]");
      writeFileSync(
        join(tmp, "universe.json"),
        JSON.stringify({
          name: "broken-cast",
          cast: "cast.json",
          devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
          sources: [{ descriptorId: "gmail", accountIds: ["a@example.com"], device: "laptop" }],
        }),
      );
      writeFileSync(
        join(tmp, "cast.json"),
        JSON.stringify({ self: "p_missing", people: [{ id: "p_a", name: "Anya" }] }),
      );
      const u = loadUniverse(tmp);
      const issues = validateUniverse(u);
      expect(issues.find((i) => /no matching entry/i.test(i.message))).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags non-reserved emails, domains, and phone numbers in universe identities", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      const badEmail = `person@${"redwoodlabs"}.com`;
      const badDomain = `${"redwoodlabs"}.com`;
      const badPhone = `+1 ${"312"} 624 0719`;
      mkdirSync(join(tmp, "sources", "gmail"), { recursive: true });
      writeFileSync(join(tmp, "sources", "gmail", "x.json"), JSON.stringify([{ badEmail }]));
      writeFileSync(
        join(tmp, "universe.json"),
        JSON.stringify({
          name: "broken-identities",
          cast: "cast.json",
          devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
          sources: [{ descriptorId: "gmail", accountIds: [badEmail, badPhone], device: "laptop" }],
        }),
      );
      writeFileSync(
        join(tmp, "cast.json"),
        JSON.stringify({
          self: "p_a",
          people: [{ id: "p_a", name: "person", emails: [badEmail], phones: [badPhone] }],
          orgs: [{ id: "o_a", name: "org", domain: badDomain }],
        }),
      );

      const u = loadUniverse(tmp);
      const messages = validateUniverse(u).map((i) => i.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/reserved example domain/),
          expect.stringMatching(/fictional test range/),
        ]),
      );
      expect(messages.find((m) => m.includes("org 'o_a'"))).toMatch(/reserved example domain/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("allows reserved example-domain emails and fictional phone ranges in universe identities", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-universe-test-"));
    try {
      mkdirSync(join(tmp, "sources", "gmail"), { recursive: true });
      writeFileSync(
        join(tmp, "sources", "gmail", "x.json"),
        JSON.stringify([{ email: "person@example.com", phone: "+1 (555) 010-0123" }]),
      );
      writeFileSync(
        join(tmp, "universe.json"),
        JSON.stringify({
          name: "clean-identities",
          cast: "cast.json",
          devices: [{ id: "laptop", name: "Test-laptop", kind: "collector" }],
          sources: [
            {
              descriptorId: "gmail",
              accountIds: ["person@example.com", "+1 (555) 010-0123"],
              device: "laptop",
            },
          ],
        }),
      );
      writeFileSync(
        join(tmp, "cast.json"),
        JSON.stringify({
          self: "p_a",
          people: [
            {
              id: "p_a",
              name: "person",
              emails: ["person@example.com"],
              phones: ["+1 (555) 010-0123"],
            },
          ],
          orgs: [{ id: "o_a", name: "org", domain: "workspace.example" }],
        }),
      );

      const u = loadUniverse(tmp);
      expect(validateUniverse(u).filter((i) => i.severity === "error")).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

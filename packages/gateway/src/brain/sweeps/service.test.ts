// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for resolving the sweep set from disk: layering a user file over a
 * system sweep, defining a new one, reporting rather than throwing on a broken
 * file, reverting cleanly, and the digest-window guard.
 *
 * The layering rules are the load-bearing part. Silencing a built-in must stay
 * a two-line file (so its prose keeps tracking the shipped version), a fork
 * must be self-contained (so the operator can read it without knowing what it
 * inherited), and deleting either must restore the system sweep byte for byte.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SweepService } from "./service.js";
import { SYSTEM_SWEEPS } from "./system-sweeps.js";
import { parseClockTime } from "./anchor.js";

const SCHEDULE = {
  dailyRunHour: 5,
  digestEnabled: true,
  digestHour: 7,
  digestGraceMinutes: 45,
};

describe("SweepService", () => {
  let configDir: string;
  let svc: SweepService;

  const write = (id: string, text: string): void => {
    mkdirSync(join(configDir, "sweeps"), { recursive: true });
    writeFileSync(join(configDir, "sweeps", `${id}.md`), text, "utf8");
  };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-sweeps-"));
    svc = new SweepService({ configDir, getScheduleContext: () => SCHEDULE });
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("with no files, the set is exactly the shipped sweeps", () => {
    const { sweeps, issues } = svc.resolve();
    expect(issues).toEqual([]);
    expect(sweeps.map((s) => s.id)).toEqual(SYSTEM_SWEEPS.map((s) => s.id));
    expect(sweeps.every((s) => s.origin === "system" && !s.modified)).toBe(true);
  });

  test("every shipped sweep declares a parseable anchor outside the digest window", () => {
    // Derived anchors dodge the window by construction; the declared ones have
    // to be checked, and this is the only place that can.
    for (const s of SYSTEM_SWEEPS) {
      const minutes = parseClockTime(s.at);
      expect(minutes, `${s.id} has an unparseable \`at\``).not.toBeNull();
    }
    // Nothing shipped conflicts: may-day anchors inside the window, but the
    // digest waits for it deliberately and it declares that.
    expect(svc.digestWindowConflicts()).toEqual([]);
  });

  test("a front-matter-only file silences a built-in and leaves its prose alone", () => {
    write("health-trends", "---\nenabled: false\n---\n");
    const s = svc.get("health-trends")!;
    expect(s.enabled).toBe(false);
    expect(s.origin).toBe("user");
    // Switched off, nothing pinned: the surfaces still show this as a shipped
    // sweep whose prose a later release can improve.
    expect(s.modified).toBe(false);
    expect(s.steeringPrompt).toBe(
      SYSTEM_SWEEPS.find((x) => x.id === "health-trends")!.steeringPrompt,
    );
  });

  test("a file layers per-field: what it omits keeps tracking the shipped sweep", () => {
    write("upcoming-horizon", "---\ncadence: 3d\n---\n");
    const s = svc.get("upcoming-horizon")!;
    expect(s.modified).toBe(true);
    expect(s.cadenceHours).toBe(72);
    expect(s.temporalAnnotationPrimeDays).toBe(21);
    expect(s.steeringPrompt).toBe(
      SYSTEM_SWEEPS.find((x) => x.id === "upcoming-horizon")!.steeringPrompt,
    );
  });

  test("primeHorizonDays: 0 removes a built-in's prime", () => {
    write("upcoming-horizon", "---\nprimeHorizonDays: 0\n---\n");
    expect(svc.get("upcoming-horizon")!.temporalAnnotationPrimeDays).toBeUndefined();
  });

  test("a file with a new id defines a sweep, and needs a cadence and prose to do it", () => {
    write("commitments-made", "---\nname: Commitments\ncadence: 7d\n---\n\nPromises not kept.\n");
    const s = svc.get("commitments-made")!;
    expect(s).toMatchObject({
      id: "commitments-made",
      name: "Commitments",
      origin: "user",
      modified: false,
      cadenceHours: 168,
      enabled: true,
      steeringPrompt: "Promises not kept.",
    });

    write("half-baked", "---\nenabled: true\n---\n");
    expect(svc.get("half-baked")).toBeNull();
    expect(svc.resolve().issues.map((i) => i.id)).toContain("half-baked");

    write("no-prose", "---\ncadence: 7d\n---\n");
    expect(svc.resolve().issues.find((i) => i.id === "no-prose")?.message).toMatch(/needs prose/);
  });

  test("a new sweep with no `at` gets a derived slot clear of the digest window", () => {
    write("commitments-made", "---\ncadence: 7d\n---\n\nProse.\n");
    const s = svc.get("commitments-made")!;
    expect(s.anchorExplicit).toBe(false);
    // 05:00 → 07:45 is the window the digest's readiness barrier wants quiet.
    const inWindow = s.anchorMinutes >= 5 * 60 && s.anchorMinutes < 7 * 60 + 45;
    expect(inWindow).toBe(false);
  });

  test("an unparseable file is reported, and the other sweeps keep running", () => {
    write("broken", "---\ncadence: sometimes\n---\n\nProse.\n");
    const { sweeps, issues } = svc.resolve();
    expect(sweeps.map((s) => s.id)).toEqual(SYSTEM_SWEEPS.map((s) => s.id));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: "broken" });
    expect(issues[0].message).toMatch(/not a duration/);
  });

  test("a file whose name cannot be a sweep id is reported, not silently skipped", () => {
    mkdirSync(join(configDir, "sweeps"), { recursive: true });
    writeFileSync(join(configDir, "sweeps", "My Sweep.md"), "Prose.\n", "utf8");
    expect(svc.resolve().issues[0]?.message).toMatch(/not a usable sweep id/);
  });

  test("fork writes a self-contained file; revert deletes it and the shipped sweep returns", () => {
    const before = svc.get("weekly-finances")!;
    svc.fork("weekly-finances");
    const file = readFileSync(join(configDir, "sweeps", "weekly-finances.md"), "utf8");
    // Self-contained: everything the resolved sweep had is written out, so the
    // operator can read the file without knowing what it inherited.
    expect(file).toContain("cadence: 7d");
    expect(file).toContain("at: ");
    expect(file).toContain(before.steeringPrompt.slice(0, 40));

    // A fork starts out identical, but it PINS the content — releases no
    // longer reach it — so it is a fork from the first moment.
    const forked = svc.get("weekly-finances")!;
    expect(forked.origin).toBe("user");
    expect(forked.modified).toBe(true);
    expect(forked.steeringPrompt).toBe(before.steeringPrompt);

    expect(svc.remove("weekly-finances")).toBe(true);
    expect(svc.get("weekly-finances")).toEqual(before);
    expect(svc.remove("weekly-finances")).toBe(false);
  });

  test("setEnabled writes the smallest file that expresses the change", () => {
    svc.setEnabled("health-trends", false);
    expect(readFileSync(join(configDir, "sweeps", "health-trends.md"), "utf8")).toBe(
      "---\nenabled: false\n---\n",
    );
    // Re-enabling an already-forked sweep keeps everything else in the file.
    svc.fork("waiting-on-others");
    svc.setEnabled("waiting-on-others", false);
    const s = svc.get("waiting-on-others")!;
    expect(s.enabled).toBe(false);
    expect(s.steeringPrompt).toBe(
      SYSTEM_SWEEPS.find((x) => x.id === "waiting-on-others")!.steeringPrompt,
    );
    expect(svc.setEnabled("does-not-exist", false)).toBeNull();
  });

  test("edits on disk are picked up without a restart", () => {
    // Both writes are the same byte length on purpose: the read cache is keyed
    // on mtime AND size, and a size-only key would pass this test while
    // missing every same-length edit an operator makes.
    write("commitments-made", "---\ncadence: 7d\n---\n\nFirst..\n");
    expect(svc.get("commitments-made")!.steeringPrompt).toBe("First..");
    write("commitments-made", "---\ncadence: 7d\n---\n\nSecond.\n");
    expect(svc.get("commitments-made")!.steeringPrompt).toBe("Second.");
  });

  test("a partial edit merges over the file instead of erasing what it omits", () => {
    // The editor sends the fields it shows. A full replace would make every
    // save destructive by omission — re-enabling a sweep the operator had
    // switched off, or dropping the cadence of one they wrote themselves.
    write("commitments-made", "---\ncadence: 7d\nenabled: false\n---\n\nOriginal.\n");
    svc.patch("commitments-made", { steeringPrompt: "Rewritten." });
    expect(svc.get("commitments-made")).toMatchObject({
      steeringPrompt: "Rewritten.",
      cadenceHours: 168,
      enabled: false,
    });

    // An absent body leaves the prose alone.
    svc.patch("commitments-made", { cadenceHours: 336, steeringPrompt: "" });
    expect(svc.get("commitments-made")).toMatchObject({
      steeringPrompt: "Rewritten.",
      cadenceHours: 336,
    });
  });

  test("a file that only retimes a system sweep keeps its brief lane", () => {
    // The lane is granted for the prose. Retiming does not change what the
    // sweep's cards say, so it must not quietly cost it the grant.
    write("may-day", '---\nat: "05:30"\n---\n');
    const s = svc.get("may-day")!;
    expect(s.briefLane).toBe("lookahead");
    expect(s.anchorMinutes).toBe(5 * 60 + 30);
    // Replacing the prose does.
    write("may-day", '---\nat: "05:30"\n---\n\nSomething else entirely.\n');
    expect(svc.get("may-day")!.briefLane).toBeUndefined();
  });

  test("legacy config overrides convert to files once, never over an existing one", () => {
    write("weekly-finances", "---\nenabled: false\n---\n");
    const migrated = svc.migrateLegacyOverrides({
      "weekly-finances": { cadenceHours: 999 },
      "reading-list": { cadenceHours: 24, steeringPrompt: "Unread saved articles." },
      "Not An Id": { cadenceHours: 24, steeringPrompt: "x" },
    });
    expect(migrated).toEqual(["reading-list"]);
    // The operator's own file was not overwritten.
    expect(svc.get("weekly-finances")!.cadenceHours).toBe(168);
    expect(svc.get("reading-list")!.steeringPrompt).toBe("Unread saved articles.");
    expect(existsSync(join(configDir, "sweeps", "Not An Id.md"))).toBe(false);
  });

  test("an id that is not a safe filename stem never reaches a path", () => {
    for (const bad of ["../escape", "dir/sub", "Upper"]) {
      expect(() => svc.save(bad, { steeringPrompt: "x" })).toThrow(/Invalid sweep id/);
      expect(() => svc.remove(bad)).toThrow(/Invalid sweep id/);
    }
  });

  test("a user sweep anchored inside the digest window is reported", () => {
    write("noisy", '---\ncadence: 7d\nat: "06:00"\n---\n\nProse.\n');
    expect(svc.digestWindowConflicts()).toEqual([{ id: "noisy", at: "06:00" }]);
    // Disabling it clears the report — a sweep that never runs cannot delay
    // anything.
    svc.setEnabled("noisy", false);
    expect(svc.digestWindowConflicts()).toEqual([]);
  });

  test("a fork of the day-ahead sweep keeps its digest exemption but loses its brief lane", () => {
    expect(svc.get("may-day")!.briefLane).toBe("lookahead");
    svc.fork("may-day");
    // The digest still has to wait for it — that is about ordering, and the
    // sweep still runs at the same point in the morning.
    expect(svc.get("may-day")!.expectedBeforeDigest).toBe(true);
    expect(svc.digestWindowConflicts()).toEqual([]);
    // The lane was granted for the prose the gateway ships. Once the operator
    // pins their own, the card faces the same bar as any other sweep's.
    expect(svc.get("may-day")!.briefLane).toBeUndefined();
    svc.remove("may-day");
    expect(svc.get("may-day")!.briefLane).toBe("lookahead");
  });

  test("switching the day-ahead sweep off does not cost it its lane", () => {
    // Nothing is pinned, so the grant still applies when it is switched back on.
    svc.setEnabled("may-day", false);
    expect(svc.get("may-day")!.briefLane).toBe("lookahead");
  });

  test("with the digest off, nothing is a digest-window conflict", () => {
    const off = new SweepService({
      configDir,
      getScheduleContext: () => ({ ...SCHEDULE, digestEnabled: false }),
    });
    expect(off.digestWindowConflicts()).toEqual([]);
  });
});

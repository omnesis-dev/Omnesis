// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { parseDuration } from "@omnesis/core";
import { validateConfig, configDefaultAt } from "@omnesis/config";
import { resolveBrainSettings, BRAIN_DEFAULTS } from "./config.js";

function defAt(path: string): unknown {
  return configDefaultAt(path.split("/").filter(Boolean));
}

describe("resolveBrainSettings", () => {
  it("applies the documented defaults for an absent block", () => {
    const r = resolveBrainSettings(undefined);
    expect(r).toEqual({
      workerConcurrency: 1,
      conversationDebounceMs: 60 * 60 * 1000,
      conversationMaxDeferMs: 6 * 60 * 60 * 1000,
      documentUpdateDebounceMs: 30 * 60 * 1000,
      documentMaxDeferMs: 4 * 60 * 60 * 1000,
      derivationBarrierMs: 30 * 60 * 1000,
      recencyWindowMs: 7 * 24 * 60 * 60 * 1000,
      // No ceiling by default — a budget nobody set must not stop the Brain.
      budget: { dailyTokens: null, dailyRuns: null },
      decayBackoffBaseMs: 24 * 60 * 60 * 1000,
      decayBackoffCapMs: 30 * 24 * 60 * 60 * 1000,
      decayDatedFloorMs: 12 * 60 * 60 * 1000,
      decayDatedFraction: 0.5,
      dailyRunHour: 5,
      notesMaxBytes: 8192,
      // Derived reconcile knobs: fanout mirrors ONE_HOP_DEFAULT_FANOUT (8),
      // deadline window is twice the 7d recency gate.
      reconcileNeighborFanout: 8,
      reconcileDeadlineWindowMs: 14 * 24 * 60 * 60 * 1000,
      // Derived delta-prime display caps.
      primeMaxLoops: 12,
      primeLedgerChars: 160,
      primeMaxDecisions: 10,
      // Proactive lane — every producer defaults on; derived caps fixed.
      awarenessAxis: true,
      synthesis: { enabled: true, cadenceHours: 24, maxPerDay: 1 },
      collision: {
        enabled: true,
        cadenceHours: 24,
        maxPerSweep: 3,
        timeHorizonDays: 60,
        annotationContradictions: { enabled: true, maxPerSweep: 2 },
      },
      digest: { enabled: true, hour: 7, graceMinutes: 45, push: true },
      annotations: { enabled: true },
      reverification: { enabled: true, intervalDays: 14, maxPerSweep: 12, batchSize: 6 },
      provenanceRecheck: { enabled: true },
      judge: { enabled: true },
      mergeAdjudication: { enabled: true },
      bootstrap: {
        enabled: true,
        direction: "recent-first",
        backlogTarget: 200,
        maxRunsPerDay: 200,
        maxRuns: 1000000,
        batchSize: 100,
      },
      sweepsEnabled: true,
      synthesisLookbackMs: 7 * 24 * 60 * 60 * 1000,
      primeMaxAnnotations: 12,
      annotationConfidenceCeiling: 0.9,
      annotationBasisCeilings: { quoted: 0.9, inferred: 0.7, synthesized: 0.55 },
      annotationConfidenceFloor: 0.25,
    });
  });

  it("resolves an empty block identically to an absent one", () => {
    expect(resolveBrainSettings({})).toEqual(resolveBrainSettings(undefined));
  });

  it("honors every override", () => {
    const r = resolveBrainSettings({
      workerConcurrency: 3,
      conversationDebounce: "2h",
      conversationMaxDefer: "12h",
      documentUpdateDebounce: "10m",
      documentMaxDefer: "3h",
      recencyWindow: "1d",
      decay: { backoffBase: "6h", backoffCap: "14d" },
      dailyRunHour: 7,
      notesMaxBytes: 4096,
      transcriptRetention: "90d",
    });
    expect(r.workerConcurrency).toBe(3);
    expect(r.conversationDebounceMs).toBe(2 * 60 * 60 * 1000);
    expect(r.conversationMaxDeferMs).toBe(12 * 60 * 60 * 1000);
    expect(r.documentUpdateDebounceMs).toBe(10 * 60 * 1000);
    expect(r.documentMaxDeferMs).toBe(3 * 60 * 60 * 1000);
    expect(r.recencyWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(r.decayBackoffBaseMs).toBe(6 * 60 * 60 * 1000);
    expect(r.decayBackoffCapMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(r.dailyRunHour).toBe(7);
    expect(r.notesMaxBytes).toBe(4096);
    // Derived: fanout is constant; the deadline window tracks the (overridden) recency gate.
    expect(r.reconcileNeighborFanout).toBe(8);
    expect(r.reconcileDeadlineWindowMs).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it("clamps each max-defer ceiling up to at least its own debounce", () => {
    // A ceiling below its debounce is nonsensical — it would clamp the first
    // fold below the intended quiet period. The resolver floors it up.
    const r = resolveBrainSettings({
      conversationDebounce: "1h",
      conversationMaxDefer: "10m",
      documentUpdateDebounce: "30m",
      documentMaxDefer: "5m",
    });
    expect(r.conversationMaxDeferMs).toBe(60 * 60 * 1000);
    expect(r.documentMaxDeferMs).toBe(30 * 60 * 1000);
  });

  it("partial decay overrides fall back per-field", () => {
    const r = resolveBrainSettings({ decay: { backoffBase: "1h" } });
    expect(r.decayBackoffBaseMs).toBe(60 * 60 * 1000);
    expect(r.decayBackoffCapMs).toBe(parseDuration(BRAIN_DEFAULTS.decay.backoffCap));
  });

  it("durations are floor-less — month-scale knobs compress to milliseconds", () => {
    // The testability-by-construction contract: a 1h debounce, the 7d recency
    // gate, and the ~1-month decay cap must all be expressible in single-digit
    // milliseconds so compressed-time tests can exercise real behaviour.
    const r = resolveBrainSettings({
      conversationDebounce: "5ms",
      conversationMaxDefer: "9ms",
      documentUpdateDebounce: "1ms",
      documentMaxDefer: "4ms",
      recencyWindow: "2ms",
      decay: { backoffBase: "1ms", backoffCap: "8ms" },
      transcriptRetention: "3ms",
    });
    expect(r.conversationDebounceMs).toBe(5);
    expect(r.conversationMaxDeferMs).toBe(9);
    expect(r.documentMaxDeferMs).toBe(4);
    expect(r.documentUpdateDebounceMs).toBe(1);
    expect(r.recencyWindowMs).toBe(2);
    expect(r.decayBackoffBaseMs).toBe(1);
    expect(r.decayBackoffCapMs).toBe(8);
  });
});

describe("brain config schema", () => {
  it("accepts millisecond-scale duration values (no schema floor)", () => {
    const res = validateConfig({
      brain: {
        conversationDebounce: "5ms",
        documentUpdateDebounce: "1ms",
        recencyWindow: "2ms",
        decay: { backoffBase: "1ms", backoffCap: "8ms" },
        transcriptRetention: "3ms",
      },
    });
    expect(res.ok, res.ok ? "" : JSON.stringify(res.errors)).toBe(true);
  });

  it("rejects unknown keys (strict block) and out-of-range hours", () => {
    expect(validateConfig({ brain: { nonsense: 1 } as never }).ok).toBe(false);
    expect(validateConfig({ brain: { dailyRunHour: 24 } }).ok).toBe(false);
    expect(validateConfig({ brain: { workerConcurrency: 0 } }).ok).toBe(false);
  });

  it("accepts a background-agent assignment keyed by the capability role id", () => {
    const res = validateConfig({
      inference: { assignments: { "background-agent": "deepseek/deepseek-chat" } },
    });
    expect(res.ok, res.ok ? "" : JSON.stringify(res.errors)).toBe(true);
    expect(validateConfig({ inference: { assignments: { "background-agent": null } } }).ok).toBe(
      true,
    );
  });
});

describe("CONFIG_DEFAULTS.brain cross-check against the live resolver", () => {
  // Same contract as config-defaults.crosscheck.test.ts: the display mirror
  // in @omnesis/config must equal what this module resolves for an empty
  // config, so the portal /config form never lies about an unset knob.
  it("matches resolveBrainSettings(undefined)", () => {
    const r = resolveBrainSettings(undefined);
    expect(defAt("/brain/workerConcurrency")).toBe(r.workerConcurrency);
    expect(parseDuration(defAt("/brain/conversationDebounce") as string)).toBe(
      r.conversationDebounceMs,
    );
    expect(parseDuration(defAt("/brain/conversationMaxDefer") as string)).toBe(
      r.conversationMaxDeferMs,
    );
    expect(parseDuration(defAt("/brain/documentUpdateDebounce") as string)).toBe(
      r.documentUpdateDebounceMs,
    );
    expect(parseDuration(defAt("/brain/documentMaxDefer") as string)).toBe(r.documentMaxDeferMs);
    expect(parseDuration(defAt("/brain/recencyWindow") as string)).toBe(r.recencyWindowMs);
    expect(parseDuration(defAt("/brain/decay/backoffBase") as string)).toBe(r.decayBackoffBaseMs);
    expect(parseDuration(defAt("/brain/decay/backoffCap") as string)).toBe(r.decayBackoffCapMs);
    expect(defAt("/brain/dailyRunHour")).toBe(r.dailyRunHour);
    expect(defAt("/brain/notesMaxBytes")).toBe(r.notesMaxBytes);
    expect(defAt("/brain/transcriptRetention")).toBeUndefined();
    expect(defAt("/brain/awarenessAxis")).toBe(r.awarenessAxis);
    expect(defAt("/brain/synthesis/enabled")).toBe(r.synthesis.enabled);
    expect(defAt("/brain/synthesis/cadenceHours")).toBe(r.synthesis.cadenceHours);
    expect(defAt("/brain/synthesis/maxPerDay")).toBe(r.synthesis.maxPerDay);
    expect(defAt("/brain/collision/enabled")).toBe(r.collision.enabled);
    expect(defAt("/brain/collision/cadenceHours")).toBe(r.collision.cadenceHours);
    expect(defAt("/brain/collision/maxPerSweep")).toBe(r.collision.maxPerSweep);
    expect(defAt("/brain/collision/annotationContradictions/enabled")).toBe(
      r.collision.annotationContradictions.enabled,
    );
    expect(defAt("/brain/collision/annotationContradictions/maxPerSweep")).toBe(
      r.collision.annotationContradictions.maxPerSweep,
    );
    expect(defAt("/brain/annotations/enabled")).toBe(r.annotations.enabled);
    expect(defAt("/brain/annotations/basisCeilings/quoted")).toBe(r.annotationBasisCeilings.quoted);
    expect(defAt("/brain/annotations/basisCeilings/inferred")).toBe(
      r.annotationBasisCeilings.inferred,
    );
    expect(defAt("/brain/annotations/basisCeilings/synthesized")).toBe(
      r.annotationBasisCeilings.synthesized,
    );
    expect(defAt("/brain/annotations/confidenceFloor")).toBe(r.annotationConfidenceFloor);
    expect(defAt("/brain/reverification/enabled")).toBe(r.reverification.enabled);
    expect(defAt("/brain/reverification/intervalDays")).toBe(r.reverification.intervalDays);
    expect(defAt("/brain/reverification/maxPerSweep")).toBe(r.reverification.maxPerSweep);
    expect(defAt("/brain/reverification/batchSize")).toBe(r.reverification.batchSize);
    // The producers that ship on: the mirror is what the portal's /config form
    // renders for an unset knob, so a drift here shows the operator a default
    // the engine is not running.
    expect(defAt("/brain/awarenessAxis")).toBe(r.awarenessAxis);
    expect(defAt("/brain/synthesis/enabled")).toBe(r.synthesis.enabled);
    expect(defAt("/brain/collision/enabled")).toBe(r.collision.enabled);
    expect(defAt("/brain/collision/annotationContradictions/enabled")).toBe(
      r.collision.annotationContradictions.enabled,
    );
    expect(defAt("/brain/digest/enabled")).toBe(r.digest.enabled);
    expect(defAt("/brain/digest/push")).toBe(r.digest.push);
    expect(defAt("/brain/digest/hour")).toBe(r.digest.hour);
    expect(defAt("/brain/provenanceRecheck/enabled")).toBe(r.provenanceRecheck.enabled);
    expect(defAt("/brain/judge/enabled")).toBe(r.judge.enabled);
    expect(defAt("/brain/mergeAdjudication/enabled")).toBe(r.mergeAdjudication.enabled);
    expect(defAt("/brain/sweepsEnabled")).toBe(r.sweepsEnabled);
    expect(defAt("/brain/bootstrap/enabled")).toBe(r.bootstrap.enabled);
    expect(defAt("/brain/bootstrap/maxRunsPerDay")).toBe(r.bootstrap.maxRunsPerDay);
    expect(defAt("/brain/bootstrap/maxRuns")).toBe(r.bootstrap.maxRuns);
  });
});

describe("proactive-lane knobs (experimental prototypes)", () => {
  it("default ON, and each honors its override", () => {
    const dflt = resolveBrainSettings(undefined);
    expect(dflt.awarenessAxis).toBe(true);
    expect(dflt.synthesis).toEqual({ enabled: true, cadenceHours: 24, maxPerDay: 1 });
    expect(dflt.collision).toEqual({
      enabled: true,
      cadenceHours: 24,
      maxPerSweep: 3,
      timeHorizonDays: 60,
      annotationContradictions: { enabled: true, maxPerSweep: 2 },
    });
    // The annotation-contradiction arm honours partial overrides per field.
    const annoTuned = resolveBrainSettings({
      collision: { annotationContradictions: { enabled: false } },
    });
    expect(annoTuned.collision.annotationContradictions).toEqual({
      enabled: false,
      maxPerSweep: 2,
    });
    // The re-verification sweep defaults on and honours partial overrides.
    expect(dflt.reverification).toEqual({
      enabled: true,
      intervalDays: 14,
      maxPerSweep: 12,
      batchSize: 6,
    });
    const revTuned = resolveBrainSettings({
      reverification: { enabled: false, intervalDays: 7 },
    });
    expect(revTuned.reverification).toEqual({
      enabled: false,
      intervalDays: 7,
      maxPerSweep: 12,
      batchSize: 6,
    });
    // Annotations graduated: on by default under experimental mode. The knob is
    // retained, so an explicit `{ enabled: false }` still turns it dflt.
    expect(dflt.annotations.enabled).toBe(true);
    expect(resolveBrainSettings({ annotations: { enabled: false } }).annotations.enabled).toBe(
      false,
    );
    // Per-basis ceilings + the abstention floor honor partial overrides,
    // falling back per-field.
    const basisTuned = resolveBrainSettings({
      annotations: { basisCeilings: { synthesized: 0.4 }, confidenceFloor: 0.3 },
    });
    expect(basisTuned.annotationBasisCeilings).toEqual({
      quoted: 0.9,
      inferred: 0.7,
      synthesized: 0.4,
    });
    expect(basisTuned.annotationConfidenceFloor).toBe(0.3);

    // An operator turning the lane down: every producer honours an explicit
    // disable, and the tuned fields survive alongside it.
    const disabled = resolveBrainSettings({
      awarenessAxis: false,
      synthesis: { enabled: false, cadenceHours: 12, maxPerDay: 2 },
      collision: { enabled: false, cadenceHours: 6, maxPerSweep: 5, timeHorizonDays: 30 },
      annotations: { enabled: false },
    });
    expect(disabled.awarenessAxis).toBe(false);
    expect(disabled.synthesis).toEqual({ enabled: false, cadenceHours: 12, maxPerDay: 2 });
    expect(disabled.collision).toEqual({
      enabled: false,
      cadenceHours: 6,
      maxPerSweep: 5,
      timeHorizonDays: 30,
      annotationContradictions: { enabled: true, maxPerSweep: 2 },
    });
    expect(disabled.annotations.enabled).toBe(false);
    // The lookback window tracks the recency gate, not a separate knob.
    expect(disabled.synthesisLookbackMs).toBe(dflt.recencyWindowMs);
  });

  // Now that these ship on, the disable is the operator's only brake — one of
  // them reaches their phone. A default nobody can turn off is a bug, so each
  // gets its own assertion rather than riding the defaults snapshot.
  it("every producer that ships on can be turned back off", () => {
    const r = resolveBrainSettings({
      digest: { enabled: false, push: false },
      provenanceRecheck: { enabled: false },
      judge: { enabled: false },
      mergeAdjudication: { enabled: false },
      sweepsEnabled: false,
    });
    expect(r.digest.enabled).toBe(false);
    expect(r.digest.push).toBe(false);
    expect(r.provenanceRecheck.enabled).toBe(false);
    expect(r.judge.enabled).toBe(false);
    expect(r.mergeAdjudication.enabled).toBe(false);
    expect(r.sweepsEnabled).toBe(false);
  });

  it("push can be silenced without losing the digest itself", () => {
    const r = resolveBrainSettings({ digest: { push: false } });
    expect(r.digest.enabled).toBe(true);
    expect(r.digest.push).toBe(false);
    expect(r.digest.hour).toBe(7);
  });

  it("partial synthesis overrides fall back per-field", () => {
    const r = resolveBrainSettings({ synthesis: { cadenceHours: 6 } });
    expect(r.synthesis).toEqual({ enabled: true, cadenceHours: 6, maxPerDay: 1 });
  });
});

describe("merge-adjudication knob", () => {
  it("defaults ON — unlike the other producers, its cost is bounded per candidate", () => {
    expect(resolveBrainSettings(undefined).mergeAdjudication.enabled).toBe(true);
    expect(resolveBrainSettings({}).mergeAdjudication.enabled).toBe(true);
  });

  it("honours an explicit disable", () => {
    const r = resolveBrainSettings({ mergeAdjudication: { enabled: false } });
    expect(r.mergeAdjudication.enabled).toBe(false);
  });

  it("the schema accepts the block and rejects unknown keys inside it", () => {
    expect(validateConfig({ brain: { mergeAdjudication: { enabled: false } } }).ok).toBe(true);
    expect(validateConfig({ brain: { mergeAdjudication: { nonsense: 1 } as never } }).ok).toBe(
      false,
    );
  });
});

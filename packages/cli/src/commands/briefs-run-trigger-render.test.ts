// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-render coverage for what `omnesis brain runs` and `brain run <id>`
 * say a run is reacting to.
 *
 * The trigger shape is the gateway's, imported from `@omnesis/core`, so a
 * variant that gains or loses a field is a type error here rather than a
 * crash the first time an operator opens a run of that kind. These cases
 * pin the rendering on top of that: every field the shape carries reaches
 * the operator, and a variant whose collection is empty says so rather than
 * printing nothing.
 *
 * All fixture data is invented.
 */

import { describe, expect, test } from "vitest";
import { renderRunTrigger, triggerLabel } from "./briefs.js";
import type { RunTrigger } from "@omnesis/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (t: RunTrigger): string => renderRunTrigger(t).map(stripAnsi).join("\n");

describe("a watch compile", () => {
  const COMPILE: RunTrigger = {
    type: "subscription-compile",
    request: "tell me when a parcel is\n  running late",
    authoredBy: "integration",
    path: "session",
    replaces: null,
    attempts: 2,
    refusalCodes: [],
    compileOnly: false,
    withoutBacktest: false,
  };

  test("shows the request, who asked, and which compiler path ran", () => {
    const out = render(COMPILE);

    // The request is the run's whole subject — a compile run with it missing
    // is unreadable, and rendering it was previously a crash.
    expect(out).toContain("request:    tell me when a parcel is running late");
    expect(out).toContain("authored:   integration");
    // `single-shot` vs `session` is the difference between a compiler that
    // could look things up and one that answered from a single prompt.
    expect(out).toContain("path:       session");
    expect(out).toContain("attempts:   2");
  });

  test("names the watch it rewrites, and the codes when it refused", () => {
    const out = render({
      ...COMPILE,
      replaces: "trg_prior",
      refusalCodes: ["out_of_scope", "no_such_source"],
    });

    expect(out).toContain("replaces:   trg_prior");
    expect(out).toContain("refused:    out_of_scope, no_such_source");
  });

  test("says when a candidate was never replayed on this install", () => {
    const out = render({ ...COMPILE, withoutBacktest: true });

    expect(out).toContain("backtest:   skipped");
    expect(render(COMPILE)).not.toContain("backtest:");
  });

  test("says when a compile installed nothing, which every other field hides", () => {
    // A preview and a compile whose install failed after it are identical in
    // every field above: same request, same path, same attempts, completed.
    const out = render({ ...COMPILE, compileOnly: true });

    expect(out).toContain("preview:    nothing was installed");
    expect(render(COMPILE)).not.toContain("preview:");
  });

  test("stays quiet about a first compile that neither retried nor refused", () => {
    const out = render({ ...COMPILE, attempts: null });

    expect(out).not.toContain("replaces:");
    expect(out).not.toContain("refused:");
    expect(out).not.toContain("attempts:");
  });

  test("labels the row by who asked and what for", () => {
    expect(triggerLabel(COMPILE)).toBe(
      "compile (integration): tell me when a parcel is running late",
    );
  });
});

describe("a synthesis collision", () => {
  test("lists both the loops and the temporal annotations that collided", () => {
    const t: RunTrigger = {
      type: "synthesis-collision",
      loopIds: ["loop_a", "loop_b"],
      temporalAnnotationIds: ["tan_1"],
    };

    expect(render(t)).toContain("collision:  loop_a, loop_b, tan_1");
    expect(triggerLabel(t)).toBe("collision loop_a,loop_b,tan_1");
  });

  test("says so rather than rendering an empty list", () => {
    expect(render({ type: "synthesis-collision", loopIds: [] })).toContain("(no members)");
  });
});

describe("a legacy row recovered from its dedupe key", () => {
  test("says the payload is gone instead of rendering blanks", () => {
    expect(render({ type: "unknown" })).toContain("unavailable");
    expect(triggerLabel({ type: "unknown" })).toBe("-");
  });
});

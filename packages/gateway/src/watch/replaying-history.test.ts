// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which sources are catching up, and which are keeping up.
 *
 * The classification is deliberately narrow: two facts the gateway owns
 * outright, both positive evidence of a replay, and no guessing at the phase
 * names a source invents for itself. The asymmetry is the design. Getting it
 * wrong in one direction connects an account and wakes a watch once per
 * historical row, which somebody reports; getting it wrong in the other makes
 * a watch quietly ignore real events, which nobody can see. So absence means
 * live, and only evidence moves a row into the quiet class.
 */

import { describe, expect, it } from "vitest";

import { isReplayingHistory, type SyncPhaseSignals } from "./replaying-history.js";

function signals(overrides: Partial<SyncPhaseSignals> = {}): SyncPhaseSignals {
  return {
    importing: () => false,
    reportedPhase: () => "incremental",
    ...overrides,
  };
}

describe("a source that is replaying what it already had", () => {
  it("is one running a history import the operator started", () => {
    expect(isReplayingHistory(signals({ importing: () => true }), "whatsapp:me")).toBe(true);
  });

  it("is one that says it is bootstrapping", () => {
    expect(isReplayingHistory(signals({ reportedPhase: () => "bootstrap" }), "gmail:me")).toBe(
      true,
    );
  });
});

describe("a source that is keeping up", () => {
  it("is one syncing incrementally", () => {
    expect(isReplayingHistory(signals(), "gmail:me")).toBe(false);
  });

  it("is one whose phase the SDK does not declare", () => {
    // A source is free to call a phase `detail-backfill` or `snapshot-balances`.
    // Deciding which of those replay history would put opinions about
    // individual sources into shared code, and being wrong here silences a
    // watch rather than making it noisy.
    expect(isReplayingHistory(signals({ reportedPhase: () => "detail-backfill" }), "s")).toBe(
      false,
    );
  });

  it("is one that has reported no phase at all", () => {
    // The case that matters most, because it is the one a wrong signal gets
    // wrong forever: a gateway-hosted push source never syncs, so it never
    // reports a phase. Everything it pushes is happening now, and a
    // classification keyed on "has this source ever completed a sync" would
    // call every one of those events history for the life of the install.
    expect(isReplayingHistory(signals({ reportedPhase: () => undefined }), "web")).toBe(false);
  });
});

describe("the signals are asked about the source in hand", () => {
  it("does not answer for one source using another's state", () => {
    const perSource = signals({
      importing: (id) => id === "whatsapp:me",
      reportedPhase: (id) => (id === "gmail:me" ? "bootstrap" : "incremental"),
    });
    expect(isReplayingHistory(perSource, "whatsapp:me")).toBe(true);
    expect(isReplayingHistory(perSource, "gmail:me")).toBe(true);
    expect(isReplayingHistory(perSource, "apple-notes:me")).toBe(false);
  });
});

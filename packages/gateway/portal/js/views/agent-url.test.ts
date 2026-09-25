// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { shouldReconcileSession, shouldReplaceLandingUrl } from "./agent.js";

describe("Deep Research conversation URL", () => {
  it("replaces the root Portal landing URL after the first send", () => {
    expect(shouldReplaceLandingUrl("/portal")).toBe(true);
    expect(shouldReplaceLandingUrl("/portal/")).toBe(true);
    expect(shouldReplaceLandingUrl("/portal/agent")).toBe(true);
    expect(shouldReplaceLandingUrl("/portal/agent/")).toBe(true);
  });

  it("keeps an already-addressed conversation URL intact", () => {
    expect(shouldReplaceLandingUrl("/portal/agent/s-research")).toBe(false);
    expect(shouldReplaceLandingUrl("/portal/agent/s-other")).toBe(false);
  });
});

describe("shouldReconcileSession", () => {
  it("skips an unsent hero session — nothing was ever persisted to resume", () => {
    expect(shouldReconcileSession("s-hero", 0, null)).toBe(false);
  });

  it("skips when there is no active session at all", () => {
    expect(shouldReconcileSession(null, 0, null)).toBe(false);
    expect(shouldReconcileSession(null, 0, "s-addressed")).toBe(false);
  });

  it("reconciles a session once at least one turn has been sent", () => {
    expect(shouldReconcileSession("s-active", 1, null)).toBe(true);
    expect(shouldReconcileSession("s-active", 5, null)).toBe(true);
  });

  it("reconciles a talk-back thread with zero visible turns, since it's addressed by URL", () => {
    // A brief/annotation/watch-firing reply thread hides its seeded prefix
    // from `turns` until the user's first reply, but it's still a real,
    // already-persisted conversation reached via its own convoId.
    expect(shouldReconcileSession("s-talkback", 0, "s-talkback")).toBe(true);
  });
});

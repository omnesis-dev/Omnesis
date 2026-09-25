// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  sourceActionMenuItems,
  sourceCanManualSync,
  sourcesErrorReducer,
} from "./sources.js";

describe("sourceCanManualSync", () => {
  test("allows manual sync for pull-based sources", () => {
    expect(sourceCanManualSync({ id: "pull-source:maya@example.com", pushBased: false })).toBe(true);
    expect(sourceCanManualSync({ id: "local-notes:local" })).toBe(true);
  });

  test("suppresses manual sync for push-based sources", () => {
    expect(sourceCanManualSync({ id: "push-source:local", pushBased: true })).toBe(false);
  });

  test("omits sync actions from the push-based source menu", () => {
    const labels = sourceActionMenuItems({ canManualSync: false }).map((item) => item.label);
    expect(labels).toEqual(["See recent", "Pause sync (keep data)", "Debug", "Remove"]);
    expect(labels).not.toContain("Sync");
    expect(labels).not.toContain("Resync");
  });

  test("keeps the pull-based source menu focused on source operations", () => {
    const labels = sourceActionMenuItems().map((item) => item.label);
    expect(labels).toEqual([
      "See recent",
      "Sync",
      "Pause sync (keep data)",
      "Debug",
      "Resync",
      "Remove",
    ]);
  });

  test("offers membership actions only for a source several devices may host", () => {
    const items = sourceActionMenuItems({ multiDevice: true, canJoin: true, canDetach: false });
    expect(items.map((item) => [item.label, item.disabled ?? false])).toEqual([
      ["See recent", false],
      ["Sync", false],
      ["Pause sync (keep data)", false],
      ["Join a device…", false],
      ["Detach a device…", true],
      ["Debug", false],
      ["Resync", false],
      ["Remove", false],
    ]);
    const full = sourceActionMenuItems({ multiDevice: true, canJoin: false, canDetach: true });
    expect(full.filter((item) => item.disabled).map((item) => item.label)).toEqual([
      "Join a device…",
    ]);
    expect(sourceActionMenuItems({ canJoin: true, canDetach: true }).map((i) => i.label)).toEqual(
      ["See recent", "Sync", "Pause sync (keep data)", "Debug", "Resync", "Remove"],
    );
  });

  test("offers a per-device resync only when the resync can be scoped to one member", () => {
    const labels = sourceActionMenuItems({ multiDevice: true, resyncPerDevice: true }).map(
      (item) => item.label,
    );
    expect(labels).toEqual([
      "See recent",
      "Sync",
      "Pause sync (keep data)",
      "Join a device…",
      "Detach a device…",
      "Debug",
      "Resync…",
      "Remove",
    ]);
    expect(sourceActionMenuItems({ multiDevice: true }).map((item) => item.label)).toContain(
      "Resync",
    );
    expect(
      sourceActionMenuItems({ canManualSync: false, resyncPerDevice: true }).map((i) => i.label),
    ).not.toContain("Resync…");
  });
});

describe("sourcesErrorReducer", () => {
  test("keeps an action failure visible across a successful status refresh", () => {
    const actionFailed = sourcesErrorReducer(
      { refresh: null, action: null },
      { type: "action-failed", message: "Gateway 502: invalid source sync response" },
    );
    const refreshed = sourcesErrorReducer(actionFailed, { type: "refresh-succeeded" });

    expect(refreshed).toEqual({
      refresh: null,
      action: "Gateway 502: invalid source sync response",
    });
  });

  test("clears the previous action failure when a new action starts", () => {
    expect(
      sourcesErrorReducer(
        { refresh: "Status refresh failed", action: "Gateway 502" },
        { type: "action-started" },
      ),
    ).toEqual({
      refresh: "Status refresh failed",
      action: null,
    });
  });
});

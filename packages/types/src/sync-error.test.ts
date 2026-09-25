// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  SyncError,
  formatSyncRemediation,
  isTransientSyncError,
  syncRemediationOf,
} from "./sync-error.js";

describe("isTransientSyncError", () => {
  test("true for a transient SyncError", () => {
    expect(isTransientSyncError(new SyncError("transient", "backend 503"))).toBe(true);
  });

  test("false for a SyncError of a non-transient kind", () => {
    for (const kind of ["auth", "network", "rate-limit", "permission", "unknown"] as const) {
      expect(isTransientSyncError(new SyncError(kind, "x"))).toBe(false);
    }
  });

  test("false for a plain Error, even one whose message mentions 503", () => {
    // The predicate is type-driven, not substring-driven — a bare Error never
    // counts, so a corrupt-binary failure that happens to mention a status code
    // doesn't get mistaken for a retryable backend blip.
    expect(isTransientSyncError(new Error("HTTP 503 in the body"))).toBe(false);
  });

  test("false for non-error values", () => {
    expect(isTransientSyncError(null)).toBe(false);
    expect(isTransientSyncError(undefined)).toBe(false);
    expect(isTransientSyncError("transient")).toBe(false);
    expect(isTransientSyncError({ kind: "transient" })).toBe(false);
  });
});

describe("SyncError remediation", () => {
  test("carries the remediation it was raised with, and none by default", () => {
    const remediation = {
      summary: "Access is required",
      steps: ["Grant it."],
      restartRequired: false,
    };
    expect(new SyncError("permission", "refused", { remediation }).remediation).toBe(remediation);
    expect(new SyncError("permission", "refused").remediation).toBeUndefined();
  });

  test("syncRemediationOf reads it off a thrown value and nothing else", () => {
    const remediation = {
      summary: "Access is required",
      steps: ["Grant it."],
      restartRequired: true,
    };
    expect(syncRemediationOf(new SyncError("permission", "refused", { remediation }))).toBe(
      remediation,
    );
    expect(syncRemediationOf(new SyncError("permission", "refused"))).toBeUndefined();
    expect(syncRemediationOf(new Error("refused"))).toBeUndefined();
    expect(syncRemediationOf({ remediation })).toBeUndefined();
  });
});

describe("formatSyncRemediation", () => {
  test("joins the summary and steps, and adds the executable and restart only when present", () => {
    expect(
      formatSyncRemediation({
        summary: "Access is required",
        steps: ["Open the pane.", "Add the binary."],
        restartRequired: false,
      }),
    ).toBe("Access is required. Open the pane. Add the binary.");
    expect(
      formatSyncRemediation({
        summary: "Access is required",
        steps: ["Open the pane."],
        executable: "/opt/example/bin/node",
        restartRequired: true,
      }),
    ).toBe(
      "Access is required. Open the pane. The executable running the collector is /opt/example/bin/node. Then restart the collector.",
    );
  });
});

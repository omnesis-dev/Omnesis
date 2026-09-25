// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { formatSyncRemediation } from "@omnesis/types";
import { fullDiskAccessRemediation, syncRemediationSchema } from "./sync-remediation.js";

describe("syncRemediationSchema", () => {
  test("accepts what fullDiskAccessRemediation authors, unchanged", () => {
    const remediation = fullDiskAccessRemediation("/opt/example/bin/node");
    expect(syncRemediationSchema.parse(remediation)).toEqual(remediation);
  });

  test("rejects a remediation with no steps, an unknown field, or an oversized summary", () => {
    const base = fullDiskAccessRemediation("/opt/example/bin/node");
    expect(syncRemediationSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(syncRemediationSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(syncRemediationSchema.safeParse({ ...base, summary: "x".repeat(201) }).success).toBe(
      false,
    );
  });
});

describe("fullDiskAccessRemediation", () => {
  test("names the grant, the pane, the executable and the restart", () => {
    const remediation = fullDiskAccessRemediation("/opt/example/bin/node");
    expect(remediation.summary).toMatch(/^full disk access is required$/i);
    expect(remediation.steps.join(" ")).toMatch(/privacy & security › full disk access/i);
    expect(remediation.executable).toBe("/opt/example/bin/node");
    expect(remediation.restartRequired).toBe(true);
  });

  test("its prose form carries the same four facts", () => {
    const prose = formatSyncRemediation(fullDiskAccessRemediation("/opt/example/bin/node"));
    expect(prose.toLowerCase()).toBe(
      "full disk access is required. " +
        "open system settings › privacy & security › full disk access. " +
        "add the executable running the collector to the list and switch it on. " +
        "the executable running the collector is /opt/example/bin/node. " +
        "then restart the collector.",
    );
  });
});

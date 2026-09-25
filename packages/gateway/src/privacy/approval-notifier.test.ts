// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { PrivacyApprovalNotifier } from "./approval-notifier.js";

describe("PrivacyApprovalNotifier", () => {
  test("publishes fixed privacy-safe copy and an opaque approval target", async () => {
    const publish = vi.fn(async () => []);
    await new PrivacyApprovalNotifier({ publish }).notify("approval-example");
    expect(publish).toHaveBeenCalledWith({
      kind: "privacy-approval",
      title: "Privacy review needed",
      body: "Open Omnesis to review a response.",
      data: { approvalId: "approval-example" },
      collapseId: "privacy:approval-example",
    });
  });

  test("does not reject when no device can accept the wake", async () => {
    const publish = vi.fn(async () => []);
    await expect(
      new PrivacyApprovalNotifier({ publish }).notify("approval-example"),
    ).resolves.toBeUndefined();
  });
});

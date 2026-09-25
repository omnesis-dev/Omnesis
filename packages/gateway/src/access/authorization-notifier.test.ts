// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";
import { AccessAuthorizationNotifier } from "./authorization-notifier.js";

describe("AccessAuthorizationNotifier", () => {
  test("selects the durable phone targets without accepting request authority", () => {
    const phoneId = DeviceId("00000000-0000-4000-8000-000000000001");
    const retentionDeviceIds = vi.fn(() => [phoneId]);
    const notifier = new AccessAuthorizationNotifier({
      retentionDeviceIds,
      wakeAuthorized: vi.fn(),
    });

    expect(notifier.targetDeviceIds()).toEqual([phoneId]);
    expect(retentionDeviceIds).toHaveBeenCalledWith();
  });

  test("best-effort wake failure cannot escape after the outbox is durable", async () => {
    const phoneId = DeviceId("00000000-0000-4000-8000-000000000001");
    const wakeAuthorized = vi.fn(async () => {
      throw new Error("synthetic carrier failure");
    });
    const notifier = new AccessAuthorizationNotifier({
      retentionDeviceIds: () => [phoneId],
      wakeAuthorized,
    });

    await expect(notifier.wakeQueued([phoneId])).resolves.toBeUndefined();
    expect(wakeAuthorized).toHaveBeenCalledWith([phoneId]);
  });
});

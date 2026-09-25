// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";
import { PushTransport } from "./push-transport.js";

describe("PushTransport", () => {
  test("diagnostic notifications open the app instead of a synthetic watch", async () => {
    const deviceId = DeviceId("00000000-0000-4000-8000-000000000001");
    const publish = vi.fn(() =>
      Promise.resolve([{ deviceId, transport: "relay" as const, ok: true as const }]),
    );

    await new PushTransport({ publish }).sendTest([deviceId]);

    expect(publish).toHaveBeenCalledWith(
      {
        kind: "diagnostic",
        title: "Omnesis",
        body: "Test notification from your gateway.",
        data: {},
        collapseId: "push-test",
      },
      [deviceId],
    );
  });
});

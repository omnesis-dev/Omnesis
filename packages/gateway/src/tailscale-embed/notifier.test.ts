// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { DeviceId, type DeviceRecord } from "@omnesis/types";
import { TailscaleJoinNotifier } from "./notifier.js";

function phone(
  id: string,
  kind: DeviceRecord["kind"],
  capabilities: Record<string, unknown>,
  revoked = false,
): DeviceRecord {
  return {
    id: DeviceId(id),
    kind,
    capabilities,
    revokedAt: revoked ? "2026-11-01T00:00:00Z" : null,
  } as unknown as DeviceRecord;
}

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const C = "00000000-0000-4000-8000-0000000000c3";
const D = "00000000-0000-4000-8000-0000000000d4";
const E = "00000000-0000-4000-8000-0000000000e5";

function setup() {
  const publish = vi.fn(async () => {});
  const devices = [
    phone(A, "ios", { tailscaleJoinNotifications: true }),
    phone(B, "android", { tailscaleJoinNotifications: true }),
    phone(C, "ios", { pairingNotifications: true }),
    phone(D, "ios", { tailscaleJoinNotifications: true }, true),
    phone(E, "collector", { tailscaleJoinNotifications: true }),
  ];
  const notifier = new TailscaleJoinNotifier(
    { publish } as never,
    () => devices,
    () => [DeviceId(A), DeviceId(C), DeviceId(D), DeviceId(E)],
  );
  return { notifier, publish };
}

const request = {
  id: "req-1",
  name: "maya-laptop",
  kind: "collector" as const,
  machine: "maya-laptop",
  login: "maya@example.com",
  requestedAt: "2026-11-14T18:00:00.000Z",
  expiresAt: "2099-11-14T18:10:00.000Z",
};

describe("TailscaleJoinNotifier", () => {
  test("a waiting request reaches only administrators' phones that can show it", async () => {
    const { notifier, publish } = setup();
    await notifier.waiting(request);
    expect(publish).toHaveBeenCalledWith(
      {
        kind: "tailscale-join",
        title: "Device waiting to join",
        body: "maya-laptop wants to join through Tailscale. Tap to review.",
        data: {},
        collapseId: "tailscale-join",
      },
      [DeviceId(A)],
      { expiresAt: Date.parse(request.expiresAt), idempotencyKey: "tailscale-join:req-1" },
    );
  });

  test("names the machine when it differs, and keeps names to one short line", async () => {
    const { notifier, publish } = setup();
    await notifier.waiting({
      ...request,
      name: `Work\u0007 sync ${"x".repeat(100)}`,
      machine: "studio-mac",
    });
    const body = (publish.mock.calls[0] as unknown[])[0] as { body: string };
    expect(body.body).toMatch(/^Work sync x+… on studio-mac wants to join/);
    expect(body.body.includes("\u0007")).toBe(false);
  });

  test("an automatic join is announced to those phones, never to the device itself", async () => {
    const { notifier, publish } = setup();
    await notifier.joined({ id: DeviceId(A), name: "maya-laptop" });
    expect(publish).not.toHaveBeenCalled();
    await notifier.joined({ id: DeviceId(E), name: "maya-laptop" });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tailscale-joined",
        body: "maya-laptop joined your gateway through Tailscale. Not you? Remove it in Devices.",
        collapseId: `tailscale-joined:${E}`,
      }),
      [DeviceId(A)],
      expect.objectContaining({ expiresAt: expect.any(Number) }),
    );
  });

  test("a publishing failure is swallowed", async () => {
    const { notifier, publish } = setup();
    publish.mockRejectedValueOnce(new Error("queue down"));
    await expect(notifier.waiting(request)).resolves.toBeUndefined();
  });
});

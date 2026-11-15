// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { GatewayCertificateMonitor } from "./gateway-certificate-monitor.js";

// Delay only this fixture's module delivery. No product hook, timer, provider or child runs.
const delivery = vi.hoisted(() => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { started, gate, entered, release };
});
vi.mock("./certificate-monitor-poller.js", async (actual) => {
  delivery.entered();
  await delivery.gate;
  return actual<typeof import("./certificate-monitor-poller.js")>();
});

test("close while a module import is pending prevents monitor creation", async () => {
  const create = vi.fn(async () => ({
    status: () => ({
      provider: "certspotter" as const,
      hostname: "gateway.example.test",
      state: "observing" as const,
      incidents: [],
    }),
    check: vi.fn(),
  }));
  const actor = new GatewayCertificateMonitor({
    env: {},
    configDir: "/fixture",
    identity: () => ({
      publicOrigin: "https://gateway.example.test",
      spkiFingerprint: "a".repeat(64),
    }),
    create,
  });
  actor.start();
  await delivery.started;
  const close = actor.close();
  expect(actor.cleanupFailure()).toMatchObject({ cleanupPending: true });
  delivery.release();
  await close;
  expect(create).not.toHaveBeenCalled();
  expect(actor.cleanupFailure()).toBeUndefined();
});

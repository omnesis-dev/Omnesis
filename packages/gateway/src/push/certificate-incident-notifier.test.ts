// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { DeviceId, type DeviceRecord } from "@omnesis/types";
import { notificationMessageSchema } from "@omnesis/core/push";
import { CertificateIncidentNotifier } from "./certificate-incident-notifier.js";

const identifiers = new Map<string, ReturnType<typeof DeviceId>>();
const id = (name: string) => {
  if (!identifiers.has(name)) identifiers.set(name, DeviceId(randomUUID()));
  return identifiers.get(name)!;
};
const device = (name: string, kind = "ios", revokedAt: number | null = null) =>
  ({ id: id(name), kind, revokedAt, capabilities: {} }) as DeviceRecord;

test("every active administrator phone, whatever its app version, gets one generic notice", async () => {
  vi.useFakeTimers({ now: Date.UTC(2028, 0, 2), toFake: ["Date"] });
  try {
    const publish = vi.fn().mockResolvedValue([]);
    const rows = [
      device("phone"),
      device("android", "android"),
      device("reader"),
      device("revoked", "ios", 1),
      device("collector", "collector"),
      device("portal", "portal"),
    ];
    const notifier = new CertificateIncidentNotifier(
      { publish },
      () => rows,
      () => rows.filter((row) => row.id !== id("reader")).map((row) => row.id),
    );
    await notifier.notify();
    expect(publish).toHaveBeenCalledOnce();
    const [message, targets, options] = publish.mock.calls[0]!;
    // A kind every app opens, and nothing that names the gateway or the certificate.
    expect(notificationMessageSchema.parse(message)).toEqual({
      kind: "diagnostic",
      title: "Security check needed",
      body: "Omnesis found a certificate for your gateway that it did not request. New devices now wait for your approval. On the gateway, run omnesis cloud status for details.",
      data: {},
      collapseId: "certificate-incident",
    });
    expect(targets).toEqual([id("phone"), id("android")]);
    expect(options).toEqual({ expiresAt: Date.UTC(2028, 0, 9) });
  } finally {
    vi.useRealTimers();
  }
});

test("no administrator phone, or a queue that refuses, sends nothing and throws nothing", async () => {
  const publish = vi.fn().mockRejectedValue(new Error("queue unavailable"));
  await new CertificateIncidentNotifier(
    { publish },
    () => [device("reader")],
    () => [],
  ).notify();
  expect(publish).not.toHaveBeenCalled();
  await new CertificateIncidentNotifier(
    { publish },
    () => [device("owner")],
    () => [id("owner")],
  ).notify();
  expect(publish).toHaveBeenCalledOnce();
});

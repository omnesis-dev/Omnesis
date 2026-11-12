// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";
import { PairingNotifier } from "./pairing-notifier.js";
import type { DeviceRecord } from "@omnesis/types";

const identifiers = new Map<string, ReturnType<typeof DeviceId>>();
const id = (name: string) => {
  if (!identifiers.has(name)) identifiers.set(name, DeviceId(randomUUID()));
  return identifiers.get(name)!;
};
const device = (name: string, kind = "ios", revokedAt: number | null = null) =>
  ({ id: id(name), kind, revokedAt, capabilities: { pairingNotifications: true } }) as DeviceRecord;
const request = () => ({
  requestId: "00000000-0000-4000-8000-000000000001",
  expiresAt: Date.now() + 600_000,
});

test("only active administrator phones receive a bounded generic pairing notification", async () => {
  const publish = vi.fn().mockResolvedValue([]);
  const rows = [
    device("phone"),
    device("android", "android"),
    device("reader"),
    device("revoked", "ios", 1),
    device("collector", "collector"),
    device("portal", "portal"),
    device("epoch-revoked", "ios", 0),
    { ...device("legacy"), capabilities: {} },
  ];
  const service = new PairingNotifier(
    { publish },
    () => rows,
    () => rows.filter((d) => d.id !== id("reader")).map((d) => d.id),
  );
  const pending = request();
  await service.notify(pending);
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    {
      kind: "device-pairing",
      title: "Device pairing request",
      body: "Review the new device under Devices → Pairing requests. Compare the verification codes before approving.",
      data: {},
      collapseId: "device-pairing:" + pending.requestId,
    },
    [id("phone"), id("android")],
    { expiresAt: pending.expiresAt, idempotencyKey: "device-pairing:" + pending.requestId },
  );
});

test("expired requests and installations without eligible administrators do not enqueue anything", async () => {
  const publish = vi.fn();
  const service = new PairingNotifier(
    { publish },
    () => [device("reader")],
    () => [],
  );
  await service.notify({ ...request(), expiresAt: Date.now() });
  await service.notify(request());
  expect(publish).not.toHaveBeenCalled();
});

test("queue and registry failures cannot reject an enrollment or escape as an unhandled notification rejection", async () => {
  const publish = vi.fn().mockRejectedValue(new Error("Synthetic queue failure"));
  await expect(
    new PairingNotifier(
      { publish },
      () => [device("phone")],
      () => [id("phone")],
    ).notify(request()),
  ).resolves.toBeUndefined();
  await expect(
    new PairingNotifier(
      { publish },
      () => {
        throw new Error("Synthetic registry shutdown");
      },
      () => [],
    ).notify(request()),
  ).resolves.toBeUndefined();
});

test("a join goes to every other administrator phone, names the device and nothing secret", async () => {
  const publish = vi.fn().mockResolvedValue([]);
  const rows = [device("phone"), device("android", "android"), device("joined"), device("reader")];
  const service = new PairingNotifier(
    { publish },
    () => rows,
    () => [id("phone"), id("android"), id("joined")],
  );
  const before = Date.now();
  await service.notifyJoined({
    deviceId: id("joined"),
    name: "Jamie's laptop",
    kind: "cli",
    signIn: "google",
  });
  expect(publish).toHaveBeenCalledOnce();
  const [message, targets, options] = publish.mock.calls[0]!;
  expect(message).toEqual({
    kind: "device-joined",
    title: "New device joined",
    body: "Jamie's laptop joined your gateway. Not you? Remove it in Devices.",
    data: {},
    collapseId: `device-joined:${id("joined")}`,
  });
  expect(targets).toEqual([id("phone"), id("android")]);
  expect(options.idempotencyKey).toBeUndefined();
  expect(options.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
});

test("a joined name cannot break the banner onto several lines", async () => {
  const publish = vi.fn().mockResolvedValue([]);
  await new PairingNotifier(
    { publish },
    () => [device("phone")],
    () => [id("phone")],
  ).notifyJoined({ deviceId: id("other"), name: "a\nb\u202Ec", kind: "ios", signIn: null });
  expect(publish.mock.calls[0]![0].body).toBe(
    "a b c joined your gateway. Not you? Remove it in Devices.",
  );
});

test("a join with nobody to tell, or a failing queue, resolves quietly", async () => {
  const publish = vi.fn().mockRejectedValue(new Error("Synthetic queue failure"));
  const service = new PairingNotifier(
    { publish },
    () => [device("phone")],
    () => [id("phone")],
  );
  const joined = { deviceId: id("phone"), name: "x", kind: "ios" as const, signIn: null };
  await expect(service.notifyJoined(joined)).resolves.toBeUndefined();
  expect(publish).not.toHaveBeenCalled();
  await expect(service.notifyJoined({ ...joined, deviceId: id("new") })).resolves.toBeUndefined();
});

test("a long name is shortened to one line and a name with nothing printable is replaced", async () => {
  const publish = vi.fn().mockResolvedValue([]);
  const service = new PairingNotifier(
    { publish },
    () => [device("phone")],
    () => [id("phone")],
  );
  const joined = { deviceId: id("other"), kind: "ios" as const, signIn: null };
  await service.notifyJoined({ ...joined, name: "x".repeat(81) });
  await service.notifyJoined({ ...joined, name: "\u0000‮\n" });
  expect(publish.mock.calls.map(([message]) => message.body)).toEqual([
    `${"x".repeat(79)}… joined your gateway. Not you? Remove it in Devices.`,
    "A device joined your gateway. Not you? Remove it in Devices.",
  ]);
});

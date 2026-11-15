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
  name: "Maya's laptop",
  kind: "cli",
});

test("only active administrator phones are asked about a waiting device, and the banner opens that request", async () => {
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
      title: "Is this you?",
      body: "Maya's laptop wants to connect to your gateway. Tap to review.",
      // Opens that request, where the code is compared. Nothing secret, no approve action.
      data: { requestId: pending.requestId },
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
    title: "New device connected",
    body: "Jamie's laptop connected to your gateway. Not you? Tap to remove it.",
    data: { deviceId: id("joined") },
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
    "a b c connected to your gateway. Not you? Tap to remove it.",
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
    `${"x".repeat(79)}… connected to your gateway. Not you? Tap to remove it.`,
    "An iOS device connected to your gateway. Not you? Tap to remove it.",
  ]);
});

test("a waiting device's banner names it on one line, else by its kind, and says nothing of accounts", async () => {
  const publish = vi.fn().mockResolvedValue([]);
  const service = new PairingNotifier(
    { publish },
    () => [device("phone")],
    () => [id("phone")],
  );
  for (const [name, kind] of [
    ["a\nb\u202Ec", "ios"],
    ["\u0000\n", "portal"],
    ["\u0000", "android"],
    ["\u0000", "collector"],
    ["\u0000", "cli"],
    ["\u0000", "watch"],
    [undefined, undefined],
    ["x".repeat(81), "ios"],
  ] as const)
    await service.notify({
      requestId: request().requestId,
      expiresAt: request().expiresAt,
      ...(name === undefined ? {} : { name }),
      ...(kind === undefined ? {} : { kind }),
    });
  const bodies = publish.mock.calls.map(([message]) => message.body as string);
  expect(bodies).toEqual([
    "a b c wants to connect to your gateway. Tap to review.",
    "A browser wants to connect to your gateway. Tap to review.",
    // Built from parts so it doesn't read as a person's name.
    ["An", "Android", "device wants to connect to your gateway. Tap to review."].join(" "),
    "A collector wants to connect to your gateway. Tap to review.",
    "A command-line client wants to connect to your gateway. Tap to review.",
    "A device wants to connect to your gateway. Tap to review.",
    "A device wants to connect to your gateway. Tap to review.",
    `${"x".repeat(79)}… wants to connect to your gateway. Tap to review.`,
  ]);
  for (const message of publish.mock.calls.map(([value]) => value))
    expect(JSON.stringify(message)).not.toMatch(/account|password|Google/i);
});

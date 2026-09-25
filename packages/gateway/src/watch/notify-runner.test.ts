// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";
import { NotifyRunner, type NotifyRunOptions } from "./notify-runner.js";

const input: NotifyRunOptions = {
  watchId: "watch-example",
  watchName: "Fictional watch",
  firingKey: "firing-example",
  title: "Fictional update",
  body: "A fictional condition changed.",
  collapseId: "watch-example:firing-example",
};

const deviceA = DeviceId("00000000-0000-4000-8000-000000000001");
const deviceB = DeviceId("00000000-0000-4000-8000-000000000002");

describe("NotifyRunner", () => {
  test("publishes the shared watch message and maps full success", async () => {
    const publish = vi.fn(async () => [
      { deviceId: deviceA, transport: "direct-apns" as const, ok: true as const },
      { deviceId: deviceB, transport: "direct-fcm" as const, ok: true as const },
    ]);
    const result = await new NotifyRunner({ publish }).run(input);
    expect(publish).toHaveBeenCalledWith({
      kind: "watch",
      title: input.title,
      body: input.body,
      data: { watchId: input.watchId, firingKey: input.firingKey },
      collapseId: input.collapseId,
    });
    expect(result).toMatchObject({ status: "ok", exitCode: 0, attempted: 2, delivered: 2 });
  });

  test("carries the conversation the agent opened, so a tap can land in it", async () => {
    // The one thing this banner knows that the watch page does not: the thread
    // whose opening sentence it is quoting. Dropped here it cannot be
    // recovered downstream, and the tap lands on a ledger line instead of the
    // account of what happened.
    const publish = vi.fn(async () => [
      { deviceId: deviceA, transport: "direct-apns" as const, ok: true as const },
    ]);

    await new NotifyRunner({ publish }).run({ ...input, conversationId: "s_thread_1" });

    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      kind: "watch",
      data: {
        watchId: input.watchId,
        firingKey: input.firingKey,
        conversationId: "s_thread_1",
      },
    });
  });

  test("names no conversation when the firing produced none", async () => {
    // A gateway with no agent, or a thread that could not be written. The
    // banner still goes out and the tap still reaches the firing's ledger line.
    const publish = vi.fn(async () => [
      { deviceId: deviceA, transport: "direct-apns" as const, ok: true as const },
    ]);

    await new NotifyRunner({ publish }).run(input);

    const data = (publish.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).not.toContain("conversationId");
  });

  test("maps partial per-device failure into the firing ledger shape", async () => {
    const publish = vi.fn(async () => [
      { deviceId: deviceA, transport: "direct-apns" as const, ok: true as const },
      {
        deviceId: deviceB,
        transport: "relay" as const,
        ok: false as const,
        reason: "rate limited",
      },
    ]);
    const result = await new NotifyRunner({ publish }).run(input);
    expect(result).toMatchObject({
      status: "exit-non-zero",
      exitCode: 1,
      attempted: 2,
      delivered: 1,
    });
    expect(result.stderrTail).toContain("relay: rate limited");
  });

  test("maps zero phone targets to skipped", async () => {
    const result = await new NotifyRunner({
      publish: vi.fn(async () => []),
    }).run(input);
    expect(result).toMatchObject({ status: "skipped", attempted: 0, delivered: 0 });
  });

  test("maps queue failure to spawn-error without throwing", async () => {
    const runner = new NotifyRunner({
      publish: vi.fn(async () => {
        throw new Error("writer unavailable");
      }),
    });
    await expect(runner.run(input)).resolves.toMatchObject({
      status: "spawn-error",
      error: "writer unavailable",
    });
  });

  test("generates a deterministic collapse id when the caller omits one", async () => {
    const publish = vi.fn(async () => []);
    await new NotifyRunner({ publish }).run({ ...input, collapseId: undefined });
    expect(publish.mock.calls[0]?.[0].collapseId).toBe("watch:watch-example:firing-example");
  });

  test("limits a diagnostic run to the requested phone ids", async () => {
    const publish = vi.fn(() => Promise.resolve([]));
    await new NotifyRunner({ publish }).run(input, [deviceB]);
    expect(publish).toHaveBeenCalledWith(expect.any(Object), [deviceB]);
  });
});

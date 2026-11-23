// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { makeCommand, SOURCE_CONTRACT_WIRE_RANGE } from "@omnesis/core";
import { requireGatewaySourceContract } from "@omnesis/gateway-client";
import { createGatewayCommandHandler } from "./gateway-command-handler.js";

afterEach(() => vi.unstubAllGlobals());

test("reconnect snapshots and authentication refuse an old gateway before dispatch", async () => {
  let health: unknown = {
    status: "ok",
    capabilities: { sourceContract: SOURCE_CONTRACT_WIRE_RANGE },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(health)),
  );
  const handle = vi.fn().mockResolvedValue({ ok: true });
  const dispatch = createGatewayCommandHandler(
    () => requireGatewaySourceContract("https://gateway.example.com"),
    [{ handle }],
  );
  const snapshot = makeCommand("sources.snapshot", { sources: [] });
  await expect(dispatch(snapshot)).resolves.toEqual({ ok: true });
  health = { status: "ok" };
  await expect(dispatch(snapshot)).rejects.toThrow("Gateway upgrade required");
  await expect(dispatch(makeCommand("auth.begin", {}))).rejects.toThrow("Gateway upgrade required");
  expect(handle).toHaveBeenCalledTimes(1);
  health = { status: "ok", capabilities: { sourceContract: SOURCE_CONTRACT_WIRE_RANGE } };
  await expect(dispatch(snapshot)).resolves.toEqual({ ok: true });
  expect(handle).toHaveBeenCalledTimes(2);
});

test("dispatch preserves fallback and errors", async () => {
  const command = makeCommand("sources.snapshot", { sources: [] });
  const fallback = vi.fn().mockResolvedValue({ ok: true });
  const guard = vi.fn().mockResolvedValue(undefined);
  const dispatch = createGatewayCommandHandler(guard, [
    { handle: () => undefined },
    { handle: fallback },
  ]);
  await expect(dispatch(command)).resolves.toEqual({ ok: true });
  expect(fallback).toHaveBeenCalledWith(command);
  await expect(createGatewayCommandHandler(guard, [])(command)).rejects.toThrow("Unknown command");
});

test.each(["device.update", "device.doctor"])(
  "%s remains reachable during a compatibility refusal",
  async (type) => {
    const guard = vi.fn().mockRejectedValue(new Error("Gateway upgrade required"));
    const handle = vi.fn().mockResolvedValue({ accepted: true });
    await expect(
      createGatewayCommandHandler(guard, [{ handle }])(makeCommand(type, {})),
    ).resolves.toEqual({ accepted: true });
    expect(guard).not.toHaveBeenCalled();
  },
);

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a command whose check answers first still waits for the command sent before it", async () => {
  // The connect-time snapshot's check answers last; the add that followed it
  // must not reach its handler first.
  const slowCheck = deferred();
  const guard = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(slowCheck.promise)
    .mockResolvedValue(undefined);
  const handled: string[] = [];
  const handle = vi.fn((command: { type: string }) => {
    handled.push(command.type);
    return Promise.resolve({ ok: true });
  });
  const dispatch = createGatewayCommandHandler(guard, [{ handle }]);

  const snapshot = dispatch(makeCommand("sources.snapshot", { sources: [] }));
  const add = dispatch(
    makeCommand("source.add", { descriptorId: "obsidian-notes", accountIds: ["a"] }),
  );
  // Both checks are under way at once; neither command has been handed off.
  expect(guard).toHaveBeenCalledTimes(2);
  await new Promise((resolve) => setImmediate(resolve));
  expect(handled).toEqual([]);

  slowCheck.resolve();
  await expect(Promise.all([snapshot, add])).resolves.toEqual([{ ok: true }, { ok: true }]);
  expect(handled).toEqual(["sources.snapshot", "source.add"]);
});

test("a refused command does not hold back the commands after it", async () => {
  const refusal = deferred();
  const guard = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(refusal.promise)
    .mockResolvedValue(undefined);
  const handle = vi.fn().mockResolvedValue({ ok: true });
  const dispatch = createGatewayCommandHandler(guard, [{ handle }]);

  const refused = dispatch(makeCommand("sources.snapshot", { sources: [] }));
  const next = dispatch(makeCommand("sources.snapshot", { sources: [] }));
  refusal.reject(new Error("Gateway upgrade required"));
  await expect(refused).rejects.toThrow("Gateway upgrade required");
  await expect(next).resolves.toEqual({ ok: true });
  expect(handle).toHaveBeenCalledTimes(1);
});

test("a long-running handler does not hold back the commands after it", async () => {
  const guard = vi.fn().mockResolvedValue(undefined);
  const firstHandler = deferred();
  const handle = vi
    .fn()
    .mockReturnValueOnce(firstHandler.promise.then(() => ({ ok: true })))
    .mockResolvedValue({ ok: false });
  const dispatch = createGatewayCommandHandler(guard, [{ handle }]);

  const first = dispatch(makeCommand("source.add", { descriptorId: "d", accountIds: ["a"] }));
  await expect(dispatch(makeCommand("sources.snapshot", { sources: [] }))).resolves.toEqual({
    ok: false,
  });
  firstHandler.resolve();
  await expect(first).resolves.toEqual({ ok: true });
});

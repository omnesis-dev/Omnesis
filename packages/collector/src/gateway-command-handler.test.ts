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

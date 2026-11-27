// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { ManagedDesktopNearbyCleanupError } from "@omnesis/core";
import {
  DesktopCollectorNearbyHints,
  desktopCollectorNearbyParent,
} from "./collector-nearby-channel.js";
import type { ChildProcess } from "node:child_process";

const profile = {
  configDir: "/example/desktop",
  instance: "desktop-" + "a".repeat(16),
  secretService: "dev.omnesis.desktop." + "a".repeat(64),
};
function childBoundary() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn((_message: unknown, callback: () => void) => {
      callback();
      return true;
    }),
  });
  return { child, exact: child as unknown as ChildProcess };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only strict request from this retained child can invoke a query and close removes its listeners", async () => {
  const { child, exact } = childBoundary();
  const provider = {
    snapshot: vi.fn(async () => []),
    remaining: vi.fn(() => undefined),
    close: vi.fn(async () => {}),
    joinRetained: vi.fn(async () => {}),
  };
  const channel = desktopCollectorNearbyParent(
    exact,
    profile,
    new AbortController().signal,
    provider,
  );
  const id = randomUUID();
  for (const value of [
    { type: "desktop-nearby-request", id },
    JSON.stringify({ type: "desktop-nearby-request", id, profile }),
    JSON.stringify({ type: "desktop-nearby-request", id: "not-an-id" }),
    "x".repeat(257),
  ])
    child.emit("message", value);
  expect(provider.snapshot).not.toHaveBeenCalled();
  child.emit("message", JSON.stringify({ type: "desktop-nearby-request", id }));
  await turn();
  expect(provider.snapshot).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(child.send.mock.calls[0]![0]))).toEqual({
    type: "desktop-nearby-response",
    id,
  });
  await channel.close();
  expect(child.listenerCount("message")).toBe(0);
  expect(child.listenerCount("disconnect")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  child.emit("message", JSON.stringify({ type: "desktop-nearby-request", id: randomUUID() }));
  expect(provider.snapshot).toHaveBeenCalledTimes(1);
});

test("one pending read cannot enqueue another or publish after cancel/disconnect", async () => {
  const { child, exact } = childBoundary();
  let release!: () => void;
  let active: AbortSignal | undefined;
  const provider = {
    snapshot: vi.fn(async (signal: AbortSignal) => {
      active = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    }),
    remaining: vi.fn(() => undefined),
    close: vi.fn(async () => {
      release();
    }),
    joinRetained: vi.fn(async () => {}),
  };
  const channel = desktopCollectorNearbyParent(
    exact,
    profile,
    new AbortController().signal,
    provider,
  );
  const id = randomUUID(),
    second = randomUUID();
  child.emit("message", JSON.stringify({ type: "desktop-nearby-request", id }));
  child.emit("message", JSON.stringify({ type: "desktop-nearby-request", id: second }));
  expect(provider.snapshot).toHaveBeenCalledTimes(1);
  child.emit("message", JSON.stringify({ type: "desktop-nearby-cancel", id }));
  expect(active!.aborted).toBe(true);
  child.connected = false;
  child.emit("disconnect");
  await channel.close();
  expect(child.send.mock.calls.map(([text]) => JSON.parse(String(text)))).toEqual([
    { type: "desktop-nearby-response", id: second },
  ]);
});

test("genuinely uncertain query retains parent close until its exact physical join completes", async () => {
  const { exact } = childBoundary();
  let joined!: () => void;
  const physical = new Promise<void>((resolve) => {
    joined = resolve;
  });
  const provider = {
    snapshot: vi.fn(async () => []),
    remaining: vi.fn(() => undefined),
    close: vi.fn(async () => {
      throw new ManagedDesktopNearbyCleanupError(undefined);
    }),
    joinRetained: vi.fn(() => physical),
  };
  const channel = desktopCollectorNearbyParent(
    exact,
    profile,
    new AbortController().signal,
    provider,
  );
  let finished = false;
  const heldClose = channel.close();
  const closing = heldClose.then(() => {
    finished = true;
  });
  await turn();
  expect(finished).toBe(false);
  expect(provider.joinRetained).toHaveBeenCalledTimes(1);
  expect(channel.close()).toBe(heldClose);
  joined();
  await closing;
  expect(finished).toBe(true);
  expect(provider.close).toHaveBeenCalledTimes(1);
});

function clientBoundary() {
  const channel = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn((_message: unknown, callback: (error?: Error) => void) => {
      callback();
      return true;
    }),
  });
  const client = new DesktopCollectorNearbyHints(channel as unknown as NodeJS.Process);
  return { channel, client };
}

test("collector accepts only matching bounded parent replies and retires all listeners", async () => {
  const { channel, client } = clientBoundary();
  const pending = client.snapshot(new AbortController().signal);
  const id = JSON.parse(String(channel.send.mock.calls[0]![0])).id;
  channel.emit("message", JSON.stringify({ type: "desktop-nearby-response", id: randomUUID() }));
  channel.emit("message", "x".repeat(4097));
  channel.emit("message", { type: "desktop-nearby-response", id });
  expect(channel.listenerCount("message")).toBe(1);
  channel.emit(
    "message",
    JSON.stringify({
      type: "desktop-nearby-response",
      id,
      snapshot: {
        format: 1,
        generation: randomUUID(),
        sequence: 1,
        state: "denied",
        candidates: [],
      },
    }),
  );
  expect(await pending).toEqual([]);
  expect(channel.listenerCount("message")).toBe(0);
  expect(channel.listenerCount("disconnect")).toBe(0);
  await client.close();
});

test("collector cancellation sends only exact cancellation id and cannot publish a late response", async () => {
  const { channel, client } = clientBoundary();
  const lifetime = new AbortController();
  const pending = client.snapshot(lifetime.signal);
  const terminal = pending.catch((error: unknown) => error);
  const id = JSON.parse(String(channel.send.mock.calls[0]![0])).id;
  lifetime.abort();
  expect(await terminal).toBe(lifetime.signal.reason);
  expect(JSON.parse(String(channel.send.mock.calls[1]![0]))).toEqual({
    type: "desktop-nearby-cancel",
    id,
  });
  expect(channel.listenerCount("message")).toBe(0);
  await client.close();
});

test("uncertain parent cleanup freezes collector reads without starting more native or IPC work", async () => {
  const { channel, client } = clientBoundary();
  const pending = client.snapshot(new AbortController().signal);
  const id = JSON.parse(String(channel.send.mock.calls[0]![0])).id;
  channel.emit("message", JSON.stringify({ type: "desktop-nearby-unconfirmed", id }));
  await expect(pending).rejects.toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  await expect(client.snapshot(new AbortController().signal)).rejects.toBeInstanceOf(
    ManagedDesktopNearbyCleanupError,
  );
  expect(channel.send).toHaveBeenCalledTimes(1);
  await client.close();
});

test("query rate capacity refills over long server lifetimes without retaining old request IDs", async () => {
  const { child, exact } = childBoundary();
  const provider = {
    snapshot: vi.fn(async () => []),
    remaining: () => undefined,
    close: async () => {},
    joinRetained: async () => {},
  };
  let clock = 0;
  const channel = desktopCollectorNearbyParent(
    exact,
    profile,
    new AbortController().signal,
    provider,
    () => clock,
  );
  const request = async () => {
    child.emit("message", JSON.stringify({ type: "desktop-nearby-request", id: randomUUID() }));
    await turn();
  };
  await request();
  await request();
  await request();
  expect(provider.snapshot).toHaveBeenCalledTimes(2);
  for (let day = 0; day < 12; day++) {
    clock += 86400000;
    await request();
  }
  expect(provider.snapshot).toHaveBeenCalledTimes(14);
  await channel.close();
});

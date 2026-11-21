// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { AccountId, ProviderType, SourceType } from "@omnesis/types";
import { makeCommand, ownedProcessCleanupReceipt } from "@omnesis/core";
import { createSourceWsHandlers } from "./source-ws-handlers.js";
import type { GatewayClient, SourceDescriptor } from "@omnesis/source-sdk";

const fixture = vi.hoisted(() => ({ entry: "" }));
vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return {
    ...actual,
    resolveSubprocessEntry: (...args: Parameters<typeof actual.resolveSubprocessEntry>) =>
      args[0] === "./auth-subprocess.ts"
        ? { command: process.execPath, args: [fixture.entry] }
        : actual.resolveSubprocessEntry(...args),
  };
});
fixture.entry = fileURLToPath(new URL("../test/auth-process-fixture.mjs", import.meta.url));

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let connected = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      connected = true;
      socket.destroy();
    });
    socket.once("error", () => socket.destroy());
    socket.once("close", () => resolve(connected));
    socket.setTimeout(1_000, () => socket.destroy());
  });
}

test("real source authentication joins its process and Windows descendants before success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-auth cohort-"));
  const descriptor: SourceDescriptor = {
    id: SourceType("test-auth-process"),
    name: "Authentication fixture",
    description: "test",
    provider: { id: ProviderType("test-provider"), name: "Test" },
    authType: "oauth",
    unitName: "items",
    authFlow: async () => AccountId("one"),
  };
  const events: Array<{ type: string; payload: unknown }> = [];
  const handlers = createSourceWsHandlers({
    sourceManager: {
      getDescriptors: () => [descriptor],
      getConfigDir: () => directory,
    } as never,
    gateway: {} as GatewayClient,
    emitEvent: (type, payload) => events.push({ type, payload }),
  });
  try {
    await handlers.handle(
      makeCommand("auth.begin", { flowId: "physical-auth", sourceType: "test-auth-process" }),
    );
    expect(ownedProcessCleanupReceipt(handlers.cleanupFailure())?.pending).toBe(true);
    let state: { port?: number } = {};
    await vi.waitFor(
      async () => {
        state = JSON.parse(await readFile(join(directory, "cohort.json"), "utf8")) as typeof state;
        expect(events.some((event) => event.type === "auth.update")).toBe(true);
      },
      { timeout: 20_000 },
    );
    expect(events.filter((event) => event.type === "auth.complete")).toEqual([]);
    if (process.platform === "win32") {
      expect(Number.isInteger(state.port)).toBe(true);
      expect(await canConnect(state.port!)).toBe(true);
    }
    await handlers.handle(makeCommand("auth.code", { flowId: "physical-auth", code: "finish" }));
    await vi.waitFor(
      () => {
        expect(events.filter((event) => event.type === "auth.complete")).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    expect(events.find((event) => event.type === "auth.complete")?.payload).toMatchObject({
      ok: true,
      accountIds: ["one@example.com"],
    });
    if (process.platform === "win32") expect(await canConnect(state.port!)).toBe(false);
  } finally {
    // A rejected close deliberately retains the fixture for its unresolved owner.
    await handlers.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

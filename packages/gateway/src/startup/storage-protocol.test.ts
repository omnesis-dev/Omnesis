// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeGatewayDatabase, initializeGatewayIndex } from "./storage.js";
import type { EventEmitter } from "node:events";

interface WorkerFixture extends EventEmitter {
  terminate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}
const fixture = vi.hoisted(() => ({ workers: [] as WorkerFixture[] }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      terminate = vi.fn(async () => 1);
      postMessage = vi.fn();
      constructor() {
        super();
        fixture.workers.push(this);
      }
    },
  };
});
beforeEach(() => {
  fixture.workers.length = 0;
});

describe("startup storage worker protocol", () => {
  it("does not expose success until the worker exited and released its store", async () => {
    let settled = false;
    const boot = initializeGatewayDatabase({ path: "/unused-example.db" });
    void boot.then(() => {
      settled = true;
    });
    const worker = fixture.workers[0]!;
    worker.emit("message", { type: "done", result: { frames: 4, ms: 12 } });
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit("exit", 0);
    await expect(boot).resolves.toEqual({ frames: 4, ms: 12 });
    expect(worker.eventNames()).toEqual([]);
  });

  it("rejects an unsuccessful exit even after a result message", async () => {
    const boot = initializeGatewayDatabase({ path: "/unused-example.db" });
    const assertion = expect(boot).rejects.toThrow("exited with code 2");
    const worker = fixture.workers[0]!;
    worker.emit("message", { type: "done", result: { frames: 0, ms: 0 } });
    worker.emit("exit", 2);
    await assertion;
  });

  it("rejects an exit with no result", async () => {
    const boot = initializeGatewayDatabase({ path: "/unused-example.db" });
    const assertion = expect(boot).rejects.toThrow("without a result");
    fixture.workers[0]!.emit("exit", 0);
    await assertion;
  });

  it("retains worker failures until cleanup exits", async () => {
    const boot = initializeGatewayDatabase({ path: "/unused-example.db" });
    const assertion = expect(boot).rejects.toThrow("example worker failure");
    const worker = fixture.workers[0]!;
    worker.emit("error", new Error("example worker failure"));
    worker.emit("exit", 1);
    await assertion;
  });

  it.each([null, { type: "done", result: { frames: -1, ms: 0 } }, { type: "unknown" }])(
    "terminates a malformed protocol without opening the next phase (%j)",
    async (message) => {
      const boot = initializeGatewayDatabase({ path: "/unused-example.db" });
      const assertion = expect(boot).rejects.toThrow("invalid message");
      const worker = fixture.workers[0]!;
      worker.emit("message", message);
      expect(worker.terminate).toHaveBeenCalledOnce();
      worker.emit("exit", 1);
      await assertion;
    },
  );

  it("cancellation waits for exit and rejects late success", async () => {
    const controller = new AbortController();
    let settled = false;
    const boot = initializeGatewayDatabase(
      { path: "/unused-example.db" },
      { signal: controller.signal },
    );
    const assertion = expect(boot).rejects.toMatchObject({ name: "AbortError" });
    void boot.catch(() => {
      settled = true;
    });
    const worker = fixture.workers[0]!;
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit("message", { type: "done", result: { frames: 0, ms: 0 } });
    worker.emit("exit", 1);
    await assertion;
  });

  it("observer exceptions cannot report a committed schema as failed", async () => {
    const boot = initializeGatewayDatabase(
      { path: "/unused-example.db" },
      {
        onMigration: () => {
          throw new Error("example observer");
        },
      },
    );
    const worker = fixture.workers[0]!;
    worker.emit("message", {
      type: "migration",
      progress: { phase: "committed", current: 1, completed: 1, total: 1, version: 3 },
    });
    worker.emit("message", { type: "done", result: { frames: 0, ms: 0 } });
    worker.emit("exit", 0);
    await expect(boot).resolves.toEqual({ frames: 0, ms: 0 });
  });

  it("cancels index preparation cooperatively so its validator can be reaped before worker exit", async () => {
    const controller = new AbortController();
    const boot = initializeGatewayIndex(
      {
        gatewayDbPath: "/unused-example.db",
        indexDbPath: "/unused-index.db",
        configDir: "/unused-config",
        storageEncryptionEnabled: false,
      },
      { signal: controller.signal },
    );
    const assertion = expect(boot).rejects.toMatchObject({ name: "AbortError" });
    const worker = fixture.workers[0]!;
    controller.abort();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "cancel" });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit("exit", 0);
    await assertion;
  });
});

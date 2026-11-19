// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { type ChatBackend } from "@omnesis/agent";
import { FsConversationStore } from "./conversation-store.js";
import { AgentService } from "./service.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
const services: AgentService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-publication-"));
  roots.push(root);
  const store = new FsConversationStore(root);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const writer = vi.spyOn(core, "atomicWriteFile").mockImplementation(async (path, body) => {
    await writeFile(path, body);
  });
  const backend: ChatBackend = {
    name: "scripted",
    model: "scripted",
    async *runTurn(input) {
      yield {
        type: "agent.message.start",
        payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
      };
      yield {
        type: "agent.text.delta",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          delta: "invented reply",
        },
      };
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "end_turn" },
      };
    },
  };
  const notified = vi.fn();
  let id = 0;
  const service = new AgentService({
    backendFactory: () => backend,
    ports: {
      search: { search: async (input) => ({ query: input.query, durationMs: 0, results: [] }) },
      document: { fetch: async () => null },
    },
    systemPrompt: "invented test prompt",
    store,
    sessionIdGen: () => `invented_${++id}`,
    onTurnComplete: notified,
  });
  services.push(service);
  return { store, writer, service, notified };
}
function receipt(service: AgentService): unknown {
  return (service as AgentService & { cleanupFailure?: () => unknown }).cleanupFailure?.();
}

test.each([false, true])(
  "turn publication uncertainty survives disposal and stops write-back/admission (nested=%s)",
  async (nested) => {
    const { service, writer, notified } = await fixture();
    const { sessionId } = await service.createSession("device:example");
    let entered!: () => void, reject!: (error: unknown) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    writer.mockImplementation(async () => {
      entered();
      await gate;
    });
    const marker = Object.assign(new Error("invented native publication uncertainty"), {
      cleanupFailure: undefined,
    });
    const error = nested ? new Error("invented wrapper", { cause: marker }) : marker;
    let closing: Promise<void> | undefined;
    try {
      service.sendMessage("device:example", sessionId, "invented request");
      await started;
      expect(core.ownedProcessCleanupReceipt(receipt(service))?.pending).toBe(true);
      closing = service.dispose();
      const verdict = expect(closing).rejects.toBe(error);
      reject(error);
      await verdict;
      expect(notified).not.toHaveBeenCalled();
      expect(receipt(service)).toBe(error);
      expect(service.dispose()).toBe(closing);
      await expect(service.dispose()).rejects.toBe(error);
      await expect(service.createSession("device:example")).rejects.toBe(error);
      expect(writer).toHaveBeenCalledOnce();
    } finally {
      reject(error);
      await Promise.allSettled([closing, service.dispose()]);
    }
  },
);

test("dispose joins an accepted direct mutation and rejects future publication", async () => {
  const { service, writer } = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  writer.mockImplementation(async (path, body) => {
    entered();
    await gate;
    await writeFile(path, body);
  });
  const opening = service.openTaskConversation("device:example", {
    taskId: "invented-task",
    snapshot: { title: "invented task", state: "open", sourceCount: 0 },
  });
  let closing: Promise<void> | undefined;
  try {
    await started;
    closing = service.dispose();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await Promise.all([opening, closing]);
    expect(receipt(service)).toBeUndefined();
    const calls = writer.mock.calls.length;
    await expect(
      service.openTaskConversation("device:example", {
        taskId: "late",
        snapshot: { title: "late", state: "open", sourceCount: 0 },
      }),
    ).rejects.toThrow();
    expect(writer).toHaveBeenCalledTimes(calls);
  } finally {
    release();
    await Promise.allSettled([opening, closing, service.dispose()]);
  }
});

test("a joined ordinary publication failure does not poison a later mutation", async () => {
  const { service, writer } = await fixture();
  writer.mockRejectedValueOnce(new Error("invented joined write failure"));
  const task = {
    taskId: "invented-task",
    snapshot: { title: "invented task", state: "open", sourceCount: 0 },
  };
  await expect(service.openTaskConversation("device:example", task)).rejects.toThrow(
    "joined write failure",
  );
  expect(receipt(service)).toBeUndefined();
  await expect(service.openTaskConversation("device:example", task)).resolves.toMatchObject({
    title: "invented task",
  });
  await service.dispose();
});

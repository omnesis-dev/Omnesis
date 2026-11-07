// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { createAcmeRenewalTask } from "./acme-task.js";
import type { TaskContext } from "../scheduler/types.js";

test("optional ACME task renews on startup/hourly with cancellation and contains failures", async () => {
  const renew = vi.fn(async (_signal: AbortSignal) => true),
    controller = { renew };
  const task = createAcmeRenewalTask(controller);
  expect(task).toMatchObject({
    name: "tls.acme",
    startDelayMs: 1000,
    periodMs: 3600000,
    priority: "background",
    runner: "main",
  });
  const abort = new AbortController(),
    context = { signal: abort.signal } as unknown as TaskContext;
  expect(await task.run(undefined, context)).toEqual({ kind: "done", value: { renewed: true } });
  expect(renew.mock.calls[0][0].aborted).toBe(false);
  abort.abort();
  expect(renew.mock.calls[0][0].aborted).toBe(true);
  renew.mockRejectedValueOnce(new Error("sensitive-provider-response"));
  expect(await task.run(undefined, context)).toEqual({ kind: "done", value: { renewed: false } });
});

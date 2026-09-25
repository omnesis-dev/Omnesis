// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { createTlsLifecycleTask } from "./task.js";
import type { TaskContext } from "../scheduler/types.js";
import type { TlsLifecycleSnapshot } from "@omnesis/core";

describe("createTlsLifecycleTask", () => {
  test("runs one refresh per tick with a bounded signal and reports the served state", async () => {
    const seen: AbortSignal[] = [];
    const task = createTlsLifecycleTask({
      refresh: async (signal) => {
        seen.push(signal);
        return { served: { state: "expiring" } } as TlsLifecycleSnapshot;
      },
    });
    expect(task.name).toBe("tls.lifecycle");
    expect(task.priority).toBe("background");
    expect(task.periodMs).toBe(60 * 60 * 1000);
    const outcome = await task.run(undefined, {
      signal: new AbortController().signal,
    } as unknown as TaskContext);
    expect(outcome).toEqual({ kind: "done", value: { state: "expiring" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(false);
  });
});

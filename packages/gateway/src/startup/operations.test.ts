// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { StartupOperations } from "./operations.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("bootstrap operation cleanup", () => {
  it("waits for cancellation cleanup, not just the abort signal", async () => {
    const operations = new StartupOperations();
    const controller = new AbortController();
    const childExited = gate();
    const work = operations.track(
      new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          void childExited.promise.then(() => reject(new Error("cancelled after reaping child")));
        });
      }),
    );
    const rejected = expect(work).rejects.toThrow("after reaping child");
    controller.abort();
    let drained = false;
    const drain = operations.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    childExited.resolve();
    await rejected;
    await drain;
    expect(drained).toBe(true);
  });

  it("also waits for work registered while an earlier operation unwinds", async () => {
    const operations = new StartupOperations();
    const initial = gate();
    const late = gate();
    const outer = operations.track(
      initial.promise.then(() => {
        void operations.track(late.promise);
      }),
    );
    let drained = false;
    const drain = operations.drain().then(() => {
      drained = true;
    });
    initial.resolve();
    await outer;
    expect(drained).toBe(false);
    late.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it("preserves values and failures and shares completed cleanup", async () => {
    const operations = new StartupOperations();
    await expect(operations.track(Promise.resolve(42))).resolves.toBe(42);
    const failure = new Error("fixture failure");
    await expect(operations.track(Promise.reject(failure))).rejects.toBe(failure);
    await Promise.all([operations.drain(), operations.drain()]);
  });
});

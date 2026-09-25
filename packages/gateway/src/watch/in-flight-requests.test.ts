// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What happens when the same request arrives twice while the first is running.
 *
 * The idempotency key deduplicates against the record a compile leaves behind,
 * which settles a retry arriving after the first finished and does nothing for
 * one arriving during it. With compiles measured in minutes and clients that
 * retry on a timeout, during it is the ordinary case.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { InFlightRequests } from "./in-flight-requests.js";

/** A run that finishes only when the test says so. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("a second arrival of a request already running", () => {
  it("waits on the first rather than starting its own", async () => {
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    let runs = 0;
    const work = () => {
      runs += 1;
      return gate.promise;
    };

    const first = inFlight.run("key", { request: "watch the thing" }, work);
    const second = inFlight.run("key", { request: "watch the thing" }, work);
    gate.resolve("one watch");

    expect(await first).toBe("one watch");
    expect(await second).toBe("one watch");
    expect(runs, "the second arrival paid for its own compile").toBe(1);
  });

  it("does not share a run with a different request wearing the same key", async () => {
    // Attaching here would hand a caller an answer computed for somebody else's
    // request, silently and with nothing to notice it by. What the second
    // request converges on afterwards is the store's rule about keys; what this
    // guarantees is only that it was compiled on its own first.
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    let runs = 0;

    const first = inFlight.run("key", { request: "watch the thing" }, () => {
      runs += 1;
      return gate.promise;
    });
    const second = inFlight.run("key", { request: "watch something else" }, () => {
      runs += 1;
      return Promise.resolve("a different watch");
    });
    gate.resolve("one watch");

    expect(await first).toBe("one watch");
    expect(await second).toBe("a different watch");
    expect(runs).toBe(2);
  });

  it("never shares between callers who chose the same name", async () => {
    // The key is a name the client picked, so two of them can pick the same
    // one. Whoever supplies it namespaces it; this asserts the map respects
    // that rather than matching on the bare name.
    const inFlight = new InFlightRequests();
    let runs = 0;
    const work = () => {
      runs += 1;
      return Promise.resolve("done");
    };
    await Promise.all([
      inFlight.run("device-a key", { request: "x" }, work),
      inFlight.run("device-b key", { request: "x" }, work),
    ]);
    expect(runs).toBe(2);
  });

  it("lets a later retry run again after the first one failed", async () => {
    // An entry left behind by a failed run would hand its rejection to every
    // later retry of a request that could now succeed.
    const inFlight = new InFlightRequests();
    let runs = 0;
    await expect(
      inFlight.run("key", { request: "x" }, () => {
        runs += 1;
        return Promise.reject(new Error("the model was unreachable"));
      }),
    ).rejects.toThrow("the model was unreachable");

    await expect(
      inFlight.run("key", { request: "x" }, () => {
        runs += 1;
        return Promise.resolve("compiled");
      }),
    ).resolves.toBe("compiled");
    expect(runs).toBe(2);
    expect(inFlight.size, "the failed run stayed in the map").toBe(0);
  });

  it("hands both callers the same failure when the shared run fails", async () => {
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    const work = () => gate.promise;
    const first = inFlight.run("key", { request: "x" }, work);
    const second = inFlight.run("key", { request: "x" }, work);
    gate.reject(new Error("the compile timed out"));
    await expect(first).rejects.toThrow("the compile timed out");
    await expect(second).rejects.toThrow("the compile timed out");
  });

  it("empties as runs settle, so the map cannot grow without bound", async () => {
    const inFlight = new InFlightRequests();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        inFlight.run(`key-${i}`, { request: i }, () => Promise.resolve(i)),
      ),
    );
    expect(inFlight.size).toBe(0);
  });
});

describe("a gateway that is stopping", () => {
  it("says so before a compile starts, and drains the ones already running", async () => {
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    const running = inFlight.run("key", { request: "x" }, () => gate.promise);

    expect(inFlight.open, "a running gateway refused a compile").toBe(true);
    inFlight.close();
    expect(inFlight.open, "a stopping gateway still accepted a compile").toBe(false);

    let drained = false;
    const drain = inFlight.whenIdle().then(() => {
      drained = true;
    });
    // The drain must not resolve while work is still running — otherwise a stop
    // would kill the compile it was meant to let finish.
    await Promise.resolve();
    expect(drained).toBe(false);

    gate.resolve("compiled");
    await drain;
    expect(drained).toBe(true);
    expect(await running).toBe("compiled");
  });

  it("drains immediately when nothing is running", async () => {
    const inFlight = new InFlightRequests();
    inFlight.close();
    await expect(inFlight.whenIdle()).resolves.toBeUndefined();
  });

  it("drains past a run that failed rather than hanging on it", async () => {
    // A compile that ends in an error still has to release the stop.
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    const failing = inFlight.run("key", { request: "x" }, () => gate.promise);
    const drain = inFlight.whenIdle();
    gate.reject(new Error("the model was unreachable"));
    await expect(failing).rejects.toThrow("the model was unreachable");
    await expect(drain).resolves.toBeUndefined();
  });
});

describe("what the count and the drain include", () => {
  it("counts a run nothing can share", async () => {
    // The operator's own compile and the agent's watch tool carry no key. A
    // count that saw only the shareable ones would read zero while one ran —
    // and that count is what the operator is told to read before restarting.
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    const running = inFlight.run(null, null, () => gate.promise);
    expect(inFlight.size).toBe(1);
    gate.resolve("compiled");
    await running;
    expect(inFlight.size).toBe(0);
  });

  it("counts the loser of a key collision, which is a compile too", async () => {
    const inFlight = new InFlightRequests();
    const first = deferred<string>();
    const second = deferred<string>();
    const a = inFlight.run("key", { request: "x" }, () => first.promise);
    const b = inFlight.run("key", { request: "y" }, () => second.promise);
    expect(inFlight.size, "the second compile was invisible to the stop").toBe(2);
    first.resolve("a");
    second.resolve("b");
    await Promise.all([a, b]);
    expect(inFlight.size).toBe(0);
  });

  it("waits for every one of them, not only the shareable ones", async () => {
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    const running = inFlight.run(null, null, () => gate.promise);
    let drained = false;
    const drain = inFlight.whenIdle().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained, "the stop did not wait for an unshareable compile").toBe(false);
    gate.resolve("compiled");
    await drain;
    expect(await running).toBe("compiled");
  });

  it("refuses to start anything once closed", async () => {
    // The backstop under the routes' own gates, and the cover for the moment
    // between a route checking `open` and calling in.
    const inFlight = new InFlightRequests();
    inFlight.close();
    let started = false;
    await expect(
      inFlight.run(null, null, () => {
        started = true;
        return Promise.resolve("compiled");
      }),
    ).rejects.toThrow(/restarting/i);
    expect(started, "a stopping gateway started a compile it cannot finish").toBe(false);
  });

  it("survives work that throws before it returns a promise", async () => {
    // A synchronous throw settling before the entry is recorded would leave one
    // behind that nothing removes — and a drain waiting on a map that never
    // empties is a stop that never completes.
    const inFlight = new InFlightRequests();
    await expect(
      inFlight.run("key", { request: "x" }, (): Promise<string> => {
        throw new Error("the compiler was not built");
      }),
    ).rejects.toThrow("the compiler was not built");
    expect(inFlight.size, "a synchronous throw leaked its entry").toBe(0);
    await expect(inFlight.whenIdle()).resolves.toBeUndefined();
    await expect(
      inFlight.run("key", { request: "x" }, () => Promise.resolve("compiled")),
    ).resolves.toBe("compiled");
  });

  it("recognises the same request however its fields were ordered", async () => {
    // A caller assembling the content from a spread or a parsed body would
    // otherwise lose coalescing silently.
    const inFlight = new InFlightRequests();
    const gate = deferred<string>();
    let runs = 0;
    const work = () => {
      runs += 1;
      return gate.promise;
    };
    const a = inFlight.run("key", { request: "x", authoredBy: "integration" }, work);
    const b = inFlight.run("key", { authoredBy: "integration", request: "x" }, work);
    gate.resolve("one watch");
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });
});

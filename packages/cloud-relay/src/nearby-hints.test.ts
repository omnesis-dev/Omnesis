// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { ManagedDesktopNearbyCleanupError } from "@omnesis/core";
import { NearbyDialOrder, readNearbyHints, withNearbyGatewayHints } from "./nearby-hints.js";

const candidates = (subnet: number) =>
  Array.from({ length: 8 }, (_, i) => ({ address: `192.168.${subnet}.${i + 1}`, port: 443 }));

test("every saved and nearby endpoint gets an early attempt despite an exhausted dial budget", () => {
  const known = candidates(1),
    fresh = candidates(2),
    order = new NearbyDialOrder();
  const early = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const dial = order.next(known, fresh);
    expect(dial).toHaveLength(8);
    for (const candidate of dial.slice(0, 2)) early.add(candidate.address);
  }
  expect(early).toEqual(new Set([...known, ...fresh].map((value) => value.address)));
  expect(known).toEqual(candidates(1));
  expect(fresh).toEqual(candidates(2));
});

test("unrelated nearby entries cannot displace saved entries and first source alternates", () => {
  const known = candidates(1),
    fresh = candidates(2),
    order = new NearbyDialOrder();
  expect(order.next(known, fresh).slice(0, 2)).toEqual([known[0], fresh[0]]);
  expect(order.next(known, fresh).slice(0, 2)).toEqual([fresh[1], known[1]]);
});

test("duplicates consume one slot and spare capacity comes from the remaining pool", () => {
  const known = candidates(1),
    order = new NearbyDialOrder();
  expect(order.next(known, known.slice(0, 1))).toEqual(known);
  expect(order.next([], known)).toHaveLength(8);
  expect(order.next([], [])).toEqual([]);
});

test.each(
  [
    [{ address: "127.0.0.1", port: 443 }],
    [{ address: "203.0.113.7", port: 443 }],
    [{ address: "fe80::1%en0", port: 443 }],
    [{ address: "192.168.1.1", port: 0 }],
    [...candidates(2), { address: "192.168.2.9", port: 443 }],
    { address: "192.168.2.1", port: 443 },
  ].map((value) => ({ value })),
)("malformed or nonprivate discovery never enters a dial list", ({ value: untrusted }) => {
  expect(new NearbyDialOrder().next(candidates(1), untrusted)).toEqual(candidates(1));
});

test("no-provider caller receives the exact headless transport without a cached close", async () => {
  const transport = { close: vi.fn(async () => {}) };
  const result = await withNearbyGatewayHints(undefined, async () => transport);
  expect(result).toBe(transport);
  await result!.close();
  await result!.close();
  expect(transport.close).toHaveBeenCalledTimes(2);
});

test("no transport closes a failing nearby provider exactly once", async () => {
  const failure = new Error("private cleanup unconfirmed");
  const provider = {
    snapshot: vi.fn(),
    close: vi.fn(() => {
      throw failure;
    }),
  };
  await expect(withNearbyGatewayHints(provider, async () => undefined)).rejects.toBe(failure);
  expect(provider.close).toHaveBeenCalledTimes(1);
});

test("startup failure preserves both original error and failed provider cleanup", async () => {
  const startup = new Error("startup failed"),
    cleanup = new Error("cleanup failed");
  const provider = {
    snapshot: vi.fn(),
    close: vi.fn(async () => {
      throw cleanup;
    }),
  };
  const result = withNearbyGatewayHints(provider, async () => {
    throw startup;
  });
  await expect(result).rejects.toMatchObject({ errors: [startup, cleanup] });
  expect(provider.close).toHaveBeenCalledTimes(1);
});

test("both cleanups start even if transport close throws synchronously, and repeat close is inert", async () => {
  const failure = new Error("transport close failed");
  const transport = {
    close: vi.fn((): Promise<void> => {
      throw failure;
    }),
  };
  const provider = { snapshot: vi.fn(), close: vi.fn(async () => {}) };
  const result = (await withNearbyGatewayHints(provider, async () => transport))!;
  const first = result.close();
  expect(result.close()).toBe(first);
  await expect(first).rejects.toBe(failure);
  expect(provider.close).toHaveBeenCalledTimes(1);
  expect(transport.close).toHaveBeenCalledTimes(1);
});

test("both close failures are preserved", async () => {
  const left = new Error("left"),
    right = new Error("right");
  const result = (await withNearbyGatewayHints(
    {
      snapshot: vi.fn(),
      close: async () => {
        throw right;
      },
    },
    async () => ({
      close: async () => {
        throw left;
      },
    }),
  ))!;
  await expect(result.close()).rejects.toMatchObject({ errors: [left, right] });
});

test("equivalent numeric IPv6 spellings consume one dial slot", () => {
  const short = { address: "fd00::1", port: 443 };
  const expanded = { address: "fd00:0:0:0:0:0:0:1", port: 443 };
  expect(new NearbyDialOrder().next([short], [expanded])).toEqual([short]);
});

test("optional expiry waits for query join while preserving the original outer budget", async () => {
  const outer = new AbortController(),
    expiry = new AbortController();
  let joined!: () => void;
  const physical = new Promise<void>((resolve) => {
    joined = resolve;
  });
  let active: AbortSignal | undefined;
  const provider = {
    snapshot: vi.fn(async (signal: AbortSignal) => {
      active = signal;
      await physical;
      throw signal.reason;
    }),
    close: vi.fn(async () => {}),
  };
  const expire = vi.fn(() => expiry.signal);
  let done = false;
  const pending = readNearbyHints(provider, outer.signal, expire).then((value) => {
    done = true;
    return value;
  });
  expiry.abort();
  await Promise.resolve();
  expect(expire).toHaveBeenCalledWith(750);
  expect(active!.aborted).toBe(true);
  expect(done).toBe(false);
  expect(outer.signal.aborted).toBe(false);
  joined();
  expect(await pending).toEqual([]);
});

test("outer expiry never permits metadata/probing after optional cleanup finishes", async () => {
  const outer = new AbortController();
  let joined!: () => void;
  const physical = new Promise<void>((resolve) => {
    joined = resolve;
  });
  const metadata = vi.fn();
  const provider = {
    snapshot: async () => {
      await physical;
      return [];
    },
    close: async () => {},
  };
  const pending = readNearbyHints(provider, outer.signal).then(metadata);
  const rejected = pending.catch((error: unknown) => error);
  outer.abort();
  joined();
  expect(await rejected).toBe(outer.signal.reason);
  expect(metadata).not.toHaveBeenCalled();
});

test("inner expiry never downgrades unconfirmed cleanup to an empty healthy hint list", async () => {
  const expiry = new AbortController();
  expiry.abort();
  const failure = new ManagedDesktopNearbyCleanupError(undefined);
  await expect(
    readNearbyHints(
      {
        snapshot: async () => {
          throw failure;
        },
        close: async () => {},
      },
      new AbortController().signal,
      () => expiry.signal,
    ),
  ).rejects.toBe(failure);
});

test("uncertain nearby close retries the same provider observation without repeating transport close", async () => {
  let confirmed = false;
  const failure = new ManagedDesktopNearbyCleanupError(undefined);
  const transport = { close: vi.fn(async () => {}) };
  const provider = {
    snapshot: vi.fn(),
    close: vi.fn(async () => {
      if (!confirmed) throw failure;
    }),
  };
  const wrapped = (await withNearbyGatewayHints(provider, async () => transport))!;
  const first = wrapped.close();
  expect(wrapped.close()).toBe(first);
  await expect(first).rejects.toBe(failure);
  await expect(wrapped.close()).rejects.toBe(failure);
  expect(transport.close).toHaveBeenCalledTimes(1);
  confirmed = true;
  await wrapped.close();
  await wrapped.close();
  expect(transport.close).toHaveBeenCalledTimes(1);
  expect(provider.close).toHaveBeenCalledTimes(3);
});

test("confirmed nearby recovery cannot erase the original transport close error", async () => {
  const transportFailure = new Error("the original transport did not close");
  const nearbyFailure = new ManagedDesktopNearbyCleanupError(undefined);
  let confirmed = false;
  const transport = {
    close: vi.fn(async () => {
      throw transportFailure;
    }),
  };
  const provider = {
    snapshot: vi.fn(),
    close: vi.fn(async () => {
      if (!confirmed) throw nearbyFailure;
    }),
  };
  const wrapped = (await withNearbyGatewayHints(provider, async () => transport))!;
  await expect(wrapped.close()).rejects.toMatchObject({
    errors: [transportFailure, nearbyFailure],
  });
  confirmed = true;
  await expect(wrapped.close()).rejects.toBe(transportFailure);
  await expect(wrapped.close()).rejects.toBe(transportFailure);
  expect(transport.close).toHaveBeenCalledTimes(1);
  expect(provider.close).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "startup keeps its exact error when provider cleanup reports the same failure: %s",
  async (sameFailure) => {
    const failure = new Error("fictional shared startup failure");
    const provider = {
      snapshot: vi.fn(),
      close: vi.fn(async () => {
        if (sameFailure) throw failure;
      }),
    };
    const start = vi.fn(async () => {
      throw failure;
    });
    await expect(withNearbyGatewayHints(provider, start)).rejects.toBe(failure);
    expect(start).toHaveBeenCalledOnce();
    expect(provider.close).toHaveBeenCalledOnce();
    expect(provider.snapshot).not.toHaveBeenCalled();
  },
);

test("an absent transport returns only after its nearby owner finishes closing", async () => {
  let entered!: () => void, release!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const joined = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = {
    snapshot: vi.fn(),
    close: vi.fn(async () => {
      entered();
      await joined;
    }),
  };
  let finished = false;
  const result = withNearbyGatewayHints(provider, async () => undefined).then((value) => {
    finished = true;
    return value;
  });
  try {
    await closing;
    expect(finished).toBe(false);
    expect(provider.snapshot).not.toHaveBeenCalled();
  } finally {
    release();
  }
  expect(await result).toBeUndefined();
  expect(provider.close).toHaveBeenCalledOnce();
});

test("expired optional discovery waits for a late fulfillment and discards its nonempty hints", async () => {
  const outer = new AbortController(),
    expiry = new AbortController();
  let entered!: () => void, fulfill!: (hints: unknown) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const physical = new Promise<unknown>((resolve) => {
    fulfill = resolve;
  });
  let active: AbortSignal | undefined;
  const provider = {
    snapshot: vi.fn(async (signal: AbortSignal) => {
      active = signal;
      entered();
      return physical;
    }),
    close: vi.fn(async () => {}),
  };
  let finished = false;
  const pending = readNearbyHints(provider, outer.signal, () => expiry.signal).then((hints) => {
    finished = true;
    return hints;
  });
  try {
    await started;
    expiry.abort();
    await Promise.resolve();
    expect(active!.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
    expect(finished).toBe(false);
  } finally {
    fulfill(candidates(1).slice(0, 1));
  }
  expect(await pending).toEqual([]);
  expect(finished).toBe(true);
  expect(provider.snapshot).toHaveBeenCalledOnce();
  expect(provider.close).not.toHaveBeenCalled();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source-index deletion answers immediately and is re-applied once the
 * in-flight indexing job stops writing. These cover the re-apply's one
 * non-obvious obligation: it must not lose work when a purge fails.
 *
 * The caller was told the removal succeeded long before this runs, and the
 * removal tombstone is already marked complete — so an id dropped here is
 * never retried by anything, and the removed source's chunk rows stay in the
 * index, still reachable by search. Retaining what failed is what makes the
 * next drain finish the job.
 */

import { describe, expect, test, vi } from "vitest";
import { applyPendingPurges } from "./pending-source-purges.js";

describe("applyPendingPurges", () => {
  test("drops every id once its purge has returned", () => {
    const purged: string[] = [];
    const { retained, failure } = applyPendingPurges(["a", "b", "c"], (id) => {
      purged.push(id);
    });
    expect(purged).toEqual(["a", "b", "c"]);
    expect([...retained]).toEqual([]);
    expect(failure).toBeNull();
  });

  test("keeps the id that threw AND everything after it", () => {
    // The regression: clearing the whole set up front loses `b` and `c`
    // permanently the moment `b` throws.
    const { retained, failure } = applyPendingPurges(["a", "b", "c"], (id) => {
      if (id === "b") throw new Error("index.db is locked");
    });
    expect([...retained].sort()).toEqual(["b", "c"]);
    expect(failure?.message).toMatch(/locked/);
  });

  test("stops at the first failure rather than pressing on", () => {
    // Whatever broke the first purge is likely to break the rest, and each
    // attempt holds the worker's thread.
    const purge = vi.fn((id: string) => {
      if (id === "a") throw new Error("disk full");
    });
    applyPendingPurges(["a", "b", "c"], purge);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  test("a retained id is finished by a later pass", () => {
    let failing = true;
    const first = applyPendingPurges(["a"], () => {
      if (failing) throw new Error("transient");
    });
    expect([...first.retained]).toEqual(["a"]);

    failing = false;
    const second = applyPendingPurges([...first.retained], () => {});
    expect([...second.retained]).toEqual([]);
    expect(second.failure).toBeNull();
  });

  test("nothing pending is a no-op", () => {
    const purge = vi.fn();
    const { retained, failure } = applyPendingPurges([], purge);
    expect([...retained]).toEqual([]);
    expect(failure).toBeNull();
    expect(purge).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * QoS contract: the background Cognition Steward's `lookup_people` must run at
 * BACKGROUND priority so it can never jump ahead of interactive person
 * lookups on the shared read-worker pool.
 *
 * The io task backing `lookup_people` defaults to `user` priority, and
 * `createGatewayPersonPort` imposes no priority of its own — so the sole
 * demotion is `backgroundLookupGate`, applied where the runtime wires the
 * person port for background runs. These tests prove that demotion directly:
 * a mock gate captures the ambient scheduler priority (`getActivePriority`)
 * at call time, and we assert it observes `"background"`. Without this net a
 * refactor that dropped the `runWithPriority("background", …)` wrapping would
 * silently reintroduce user-priority contention with every existing test
 * still green.
 */

import { describe, test, expect } from "vitest";
import { createGatewayPersonPort } from "../../agent/ports.js";
import { getActivePriority, type Priority } from "../../priority.js";
import { backgroundLookupGate } from "./runtime.js";
import type { PersonLookupGate } from "../../domain/person-lookup.js";
import type { Db } from "../../data/types.js";

/**
 * A gate that records the ambient scheduler priority seen when its
 * `lookupPeople` runs. `"unset"` distinguishes "never called" from a genuine
 * `null` (no priority scope on the stack).
 */
function capturingGate(): { gate: PersonLookupGate; seen: () => Priority | null | "unset" } {
  let observed: Priority | null | "unset" = "unset";
  return {
    gate: {
      lookupPeople: async () => {
        observed = getActivePriority();
        return [];
      },
    },
    seen: () => observed,
  };
}

describe("backgroundLookupGate — the Cognition Steward's lookup_people QoS contract", () => {
  test("runs the underlying gate inside a background-priority scope", async () => {
    const { gate, seen } = capturingGate();
    await backgroundLookupGate(gate).lookupPeople("Maya Reeves", 5, { experimental: false });
    expect(seen()).toBe("background");
  });

  test("the raw gate observes no imposed priority — the wrapper is what sets background", async () => {
    // Called bare (as an interactive lookup would be, off no explicit scope),
    // the gate sees null. This is why the wrapper is load-bearing: nothing
    // downstream of it re-imposes background.
    const { gate, seen } = capturingGate();
    await gate.lookupPeople("Maya Reeves", 5, { experimental: false });
    expect(seen()).toBeNull();
  });

  test("the person port wired with the wrapped gate invokes it at background priority", async () => {
    // The exact composition the runtime wires for background runs:
    // createGatewayPersonPort(db, { lookupGate: backgroundLookupGate(gate) }).
    // A present gate short-circuits the port's own sync assembly before it
    // touches the db, so a stub db is sufficient.
    const { gate, seen } = capturingGate();
    const port = createGatewayPersonPort({} as unknown as Db, {
      lookupGate: backgroundLookupGate(gate),
    });
    await port.lookup({ query: "Maya Reeves", limit: 5 });
    expect(seen()).toBe("background");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A quota park has to reach the gateway, and it has to respect a longer wait.
 *
 * Parking a source's siblings is what stops each of them spending a request to
 * rediscover a limit one of them already hit. But the park is only useful if
 * it is visible and if it does not undo itself: a fleet going quiet with
 * nothing on screen to explain it is indistinguishable from a fleet with
 * nothing to do, and a short limit that overwrites a long one releases a
 * source early on the strength of a narrower budget some sibling exhausted.
 */

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { SourceRegistry } from "./source-registry.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { FileWatcherManager } from "./file-watcher-manager.js";
import type { RegisteredSource, StatusChangeEvent } from "./sync-engine-types.js";

const PROVIDER = ProviderId("strava:athlete");

function source(id: string): RegisteredSource {
  return {
    id: SourceId(id),
    name: id,
    providerId: PROVIDER,
    instance: { sync: async () => ({ documents: [], hasMore: false, cursor: {} }) },
  } as unknown as RegisteredSource;
}

/** A registry holding three sources of one provider, all idle. */
function registryWithSiblings(): { registry: SourceRegistry; events: StatusChangeEvent[] } {
  const registry = new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
  registry.registerProvider({
    id: PROVIDER,
    name: "Strava",
    sources: [
      source("strava-activities:athlete"),
      source("strava-kudos:athlete"),
      source("strava-routes:athlete"),
    ],
  } as unknown as Parameters<SourceRegistry["registerProvider"]>[0]);

  const events: StatusChangeEvent[] = [];
  registry.onStatusChange((e) => events.push(e));
  return { registry, events };
}

const origin = source("strava-activities:athlete");
const HOUR = 3_600_000;

describe("parking the siblings that share an exhausted budget", () => {
  test("every parked sibling is announced, not just written down", () => {
    const { registry, events } = registryWithSiblings();

    const parked = registry.markQuotaExhausted(origin, { kind: "app" }, HOUR, "90 per 15 minutes");

    expect(parked).toBe(2);
    // Without an event the gateway shows these sources idle while they sit out
    // a back-off it was never told about.
    const announced = events.map((e) => e.sourceId).sort();
    expect(announced).toEqual(["strava-kudos:athlete", "strava-routes:athlete"]);
    for (const e of events) expect(e.status.state).toBe("rate-limited");
  });

  test("the source that threw is left to its own caller", () => {
    const { registry, events } = registryWithSiblings();
    registry.markQuotaExhausted(origin, { kind: "app" }, HOUR);
    expect(events.map((e) => e.sourceId)).not.toContain(origin.id);
  });

  test("a sibling already parked for longer keeps the longer wait", () => {
    const { registry, events } = registryWithSiblings();

    // Six hours, the shape an open-banking back-off takes.
    registry.markQuotaExhausted(origin, { kind: "app" }, 6 * HOUR);
    events.length = 0;

    // A narrower limit must not release it five hours early.
    registry.markQuotaExhausted(origin, { kind: "app" }, HOUR);

    expect(registry.getStatus("strava-kudos:athlete")?.retryAfterMs).toBe(6 * HOUR);
    // And it is not re-announced, because nothing about it changed.
    expect(events).toEqual([]);
  });

  test("a longer limit does extend a sibling already parked for less", () => {
    const { registry } = registryWithSiblings();
    registry.markQuotaExhausted(origin, { kind: "app" }, HOUR);
    registry.markQuotaExhausted(origin, { kind: "app" }, 6 * HOUR);
    expect(registry.getStatus("strava-kudos:athlete")?.retryAfterMs).toBe(6 * HOUR);
  });

  test("a source the operator disabled is not resurrected by someone else's limit", async () => {
    const { registry } = registryWithSiblings();
    await registry.disableSource("strava-kudos:athlete");

    registry.markQuotaExhausted(origin, { kind: "app" }, HOUR);

    expect(registry.getStatus("strava-kudos:athlete")?.state).toBe("disabled");
  });
});

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
 *
 * And the park has to reach the right siblings. Too few, and a source whose
 * budget is spent goes on showing as idle; too many, and sources that were
 * working show as paused by a limit that was never theirs.
 */

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { SourceRegistry } from "./source-registry.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { FileWatcherManager } from "./file-watcher-manager.js";
import type { RegisteredSource, StatusChangeEvent } from "./sync-engine-types.js";

const PROVIDER = ProviderId("strava:athlete");

function source(id: string, providerId: string = PROVIDER): RegisteredSource {
  return {
    id: SourceId(id),
    name: id,
    providerId: ProviderId(providerId),
    instance: { sync: async () => ({ documents: [], hasMore: false, cursor: {} }) },
  } as unknown as RegisteredSource;
}

/**
 * A registry holding one provider per key, each with the sources listed under
 * it — one provider per account, as the instantiator builds them.
 */
function registryOf(providers: Record<string, string[]>): SourceRegistry {
  const registry = new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
  for (const [providerId, sourceIds] of Object.entries(providers)) {
    registry.registerProvider({
      id: ProviderId(providerId),
      name: providerId,
      sources: sourceIds.map((id) => source(id, providerId)),
    } as unknown as Parameters<SourceRegistry["registerProvider"]>[0]);
  }
  return registry;
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

describe("which sources share the budget a limit was counted against", () => {
  test("an application limit parks another account on the same application", () => {
    // Every account a collector holds for a provider signs in through the one
    // application credential, so a limit counted against that application is
    // already spent for the second account before it makes a request.
    const registry = registryOf({
      "strava:10001": ["strava-activities:10001"],
      "strava:10002": ["strava-activities:10002"],
    });

    const parked = registry.markQuotaExhausted(
      source("strava-activities:10001", "strava:10001"),
      { kind: "app" },
      HOUR,
    );

    expect(parked).toBe(1);
    const sibling = registry.getStatus("strava-activities:10002");
    expect(sibling?.state, "the other account shares the application budget").toBe("rate-limited");
    expect(sibling?.retryAfterMs).toBe(HOUR);
  });

  test("an account limit stays on the credential that hit it", () => {
    // A credential belongs to a provider and an account together. The account
    // name alone is shared by unrelated providers signed in with one address,
    // and pausing a note-taker for a mailbox's limit invents an outage.
    const registry = registryOf({
      "mailhost:maya@example.com": [
        "mailhost-mail:maya@example.com",
        "mailhost-calendar:maya@example.com",
      ],
      "notetaker:maya@example.com": ["notetaker:maya@example.com"],
      "mailhost:jamie@example.com": ["mailhost-mail:jamie@example.com"],
    });

    const parked = registry.markQuotaExhausted(
      source("mailhost-mail:maya@example.com", "mailhost:maya@example.com"),
      { kind: "account" },
      HOUR,
    );

    expect(parked).toBe(1);
    expect(registry.getStatus("mailhost-calendar:maya@example.com")?.state).toBe("rate-limited");
    expect(
      registry.getStatus("notetaker:maya@example.com")?.state,
      "another provider on the same address has its own credential",
    ).toBe("idle");
    expect(registry.getStatus("mailhost-mail:jamie@example.com")?.state).toBe("idle");
  });

  test("an application limit stays with its own provider", () => {
    // Widening the application key past the provider would pause every source
    // that happens to share an account id with the one that hit the limit.
    const registry = registryOf({
      "strava:10001": ["strava-activities:10001"],
      "fitlog:10001": ["fitlog-workouts:10001"],
    });

    const parked = registry.markQuotaExhausted(
      source("strava-activities:10001", "strava:10001"),
      { kind: "app" },
      HOUR,
    );

    expect(parked).toBe(0);
    expect(registry.getStatus("fitlog-workouts:10001")?.state).toBe("idle");
  });
});

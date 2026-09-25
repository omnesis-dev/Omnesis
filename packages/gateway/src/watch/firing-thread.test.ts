// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The join between a firing and the agent that opens a conversation about
 * it: what the agent is told, that a redelivered firing reuses the thread
 * it already has, and that a missing agent is a rejection the push adapter
 * can degrade from.
 *
 * All fixture data is invented.
 */

import { describe, expect, it } from "vitest";

import {
  createWatchFiringThreadOpener,
  WATCH_FIRING_CALLER_ID,
  WatchFiringThreadNoAgentError,
  type WatchFiringThreadAgentPort,
} from "./firing-thread.js";
import type { WatchFiringThreadRequest } from "./delivery.js";
import type { OpenWatchFiringThreadInput } from "../agent/watch-firing-thread.js";

const REQUEST: WatchFiringThreadRequest = {
  watchId: "w_venue_hold",
  firingId: "w_venue_hold:17:notify:k1:0",
  watchName: "Venue booking confirmations",
  condition: "the events team confirms a booked date for the launch party",
  firedAt: Date.parse("2026-05-04T09:15:00.000Z"),
  evidenceDocumentIds: ["doc_confirmation", "doc_confirmation_attachment"],
};

const THREAD = {
  conversationId: "s_venue_thread",
  openingMessage: "The riverside room is held for the 12th; the deposit is due Friday.",
};

function agentPort(overrides: Partial<WatchFiringThreadAgentPort> = {}): {
  port: WatchFiringThreadAgentPort;
  opened: OpenWatchFiringThreadInput[];
  callers: string[];
  askedAbout: string[];
} {
  const opened: OpenWatchFiringThreadInput[] = [];
  const callers: string[] = [];
  const askedAbout: string[] = [];
  return {
    opened,
    callers,
    askedAbout,
    port: {
      findWatchFiringThread: async (firingId) => {
        askedAbout.push(firingId);
        return null;
      },
      openWatchFiringThread: async (callerId, input) => {
        callers.push(callerId);
        opened.push(input);
        return THREAD;
      },
      ...overrides,
    },
  };
}

describe("createWatchFiringThreadOpener", () => {
  it("tells the agent what the operator asked for and what made it true", async () => {
    const agent = agentPort();
    const open = createWatchFiringThreadOpener({ getAgent: () => agent.port });

    expect(await open(REQUEST)).toEqual(THREAD);
    expect(agent.opened).toEqual([
      {
        firingId: REQUEST.firingId,
        watchId: REQUEST.watchId,
        watchName: REQUEST.watchName,
        condition: REQUEST.condition,
        firedAt: REQUEST.firedAt,
        evidenceDocumentIds: REQUEST.evidenceDocumentIds,
      },
    ]);
    // Firings bill to their own session bucket, so one can never evict a
    // conversation the operator is in the middle of.
    expect(agent.callers).toEqual([WATCH_FIRING_CALLER_ID]);
  });

  it("reuses the thread a redelivered firing already opened", async () => {
    const agent = agentPort({ findWatchFiringThread: async () => THREAD });
    const open = createWatchFiringThreadOpener({ getAgent: () => agent.port });

    expect(await open(REQUEST)).toEqual(THREAD);
    // No second conversation about the same event, and no second turn paid
    // for to write it.
    expect(agent.opened).toEqual([]);
  });

  it("keys reuse on the firing's full identity, not the watch or the tick", async () => {
    // A watch that comes true twice is two things to be told about — and one
    // tick can produce both, since a broadcast arm re-judges every live cell at
    // the tick's own sequence number. Keying on the watch, or on the watch and
    // the sequence, folds the second into the first and leaves the operator
    // reading about an event that is not the one they were told about.
    const agent = agentPort();
    const open = createWatchFiringThreadOpener({ getAgent: () => agent.port });

    await open(REQUEST);
    await open({ ...REQUEST, firingId: "w_venue_hold:17:notify:k2:0" });

    expect(agent.askedAbout).toEqual([
      "w_venue_hold:17:notify:k1:0",
      "w_venue_hold:17:notify:k2:0",
    ]);
    expect(agent.opened.map((input) => input.firingId)).toEqual([
      "w_venue_hold:17:notify:k1:0",
      "w_venue_hold:17:notify:k2:0",
    ]);
  });

  it("rejects when no agent is configured, so the firing degrades", async () => {
    const open = createWatchFiringThreadOpener({
      getAgent: () => null,
      agentWaitMs: 0,
      sleep: async () => {},
    });
    await expect(open(REQUEST)).rejects.toThrow(WatchFiringThreadNoAgentError);
  });

  it("waits out a backend that is still swapping in rather than degrading", async () => {
    // The backend is re-resolved rather than held, so changing the assigned
    // model takes it away and puts it back. A firing landing in that window
    // used to ship the plain banner for a reason that had stopped being true
    // before it arrived.
    const agent = agentPort();
    const slept: number[] = [];
    let asked = 0;
    const open = createWatchFiringThreadOpener({
      getAgent: () => (++asked > 3 ? agent.port : null),
      agentWaitMs: 5_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(await open(REQUEST)).toEqual(THREAD);
    // Three refusals, so three waits — and the wait is polled rather than
    // spent in one block, or a backend back after 300ms would still cost the
    // whole budget.
    expect(slept).toEqual([250, 250, 250]);
  });

  it("gives up once the wait is spent, and does not wait for an agent already there", async () => {
    const agent = agentPort();
    const spent: number[] = [];
    const open = createWatchFiringThreadOpener({
      getAgent: () => null,
      agentWaitMs: 1_000,
      sleep: async (ms) => {
        spent.push(ms);
      },
    });
    await expect(open(REQUEST)).rejects.toThrow(WatchFiringThreadNoAgentError);
    // Bounded: an install with no agent at all must not stall every firing it
    // ever has for the length of a swap it will never complete.
    expect(spent).toEqual([250, 250, 250, 250]);

    const ready: number[] = [];
    const immediate = createWatchFiringThreadOpener({
      getAgent: () => agent.port,
      sleep: async (ms) => {
        ready.push(ms);
      },
    });
    expect(await immediate(REQUEST)).toEqual(THREAD);
    // The ordinary case pays nothing for the case that is not.
    expect(ready).toEqual([]);
  });

  it("spends the wait once on an install with no agent, not on every firing", async () => {
    // A swap is a gap between two agents and worth waiting out. An install
    // with no agent is not a gap, and paying the budget on every firing
    // forever is the stall the bound exists to avoid — it was costing the
    // delivery E2E its daily cap, six firings at five seconds each.
    const spent: number[] = [];
    const open = createWatchFiringThreadOpener({
      getAgent: () => null,
      agentWaitMs: 1_000,
      sleep: async (ms) => {
        spent.push(ms);
      },
    });

    await expect(open(REQUEST)).rejects.toThrow(WatchFiringThreadNoAgentError);
    const afterFirst = spent.length;
    expect(afterFirst).toBeGreaterThan(0);

    for (const seq of [2, 3, 4]) {
      await expect(open({ ...REQUEST, firingId: `w:${seq}` })).rejects.toThrow(
        WatchFiringThreadNoAgentError,
      );
    }
    expect(spent.length, "every firing paid the wait again").toBe(afterFirst);
  });

  it("waits again once an agent has been seen", async () => {
    // Having given up is not permanent. An agent that turns up — a swap that
    // finished, a backend that came back — makes the next gap a gap again.
    const agent = agentPort();
    const spent: number[] = [];
    let present = false;
    const open = createWatchFiringThreadOpener({
      getAgent: () => (present ? agent.port : null),
      agentWaitMs: 500,
      sleep: async (ms) => {
        spent.push(ms);
      },
    });

    await expect(open(REQUEST)).rejects.toThrow(WatchFiringThreadNoAgentError);
    const afterGivingUp = spent.length;

    present = true;
    expect(await open(REQUEST)).toEqual(THREAD);
    expect(spent.length, "an agent that was there cost a wait").toBe(afterGivingUp);

    present = false;
    await expect(open(REQUEST)).rejects.toThrow(WatchFiringThreadNoAgentError);
    expect(spent.length, "the wait was not restored by an agent appearing").toBeGreaterThan(
      afterGivingUp,
    );
  });
});

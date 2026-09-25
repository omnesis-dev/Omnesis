// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The join between a firing and the agent that opens a conversation about it.
 *
 * The push adapter knows a watch fired, what it is called, what was asked, and
 * which documents made it true — a firing carries all of that. So this is the
 * thin part: bill the conversation to the firings' own caller bucket, and reuse
 * an existing thread rather than opening a second one for a firing already
 * written about.
 */

import type { OpenWatchFiringThreadInput } from "../agent/watch-firing-thread.js";
import type { WatchFiringThread, WatchFiringThreadRequest } from "./delivery.js";

/**
 * Caller identity for agent-opened firing threads.
 *
 * Deliberately not a device or token id. Sessions are capped per caller and
 * evicted oldest-first within that cap, so billing a firing to whichever
 * client happened to be paired could evict a conversation the operator was
 * in the middle of. Firings share one bucket of their own instead — an
 * eviction there costs nothing, because the transcript is already persisted
 * by the time the notification goes out.
 */
export const WATCH_FIRING_CALLER_ID = "watch:firing";

/** What the opener needs from the agent. */
export interface WatchFiringThreadAgentPort {
  findWatchFiringThread(firingId: string): Promise<WatchFiringThread | null>;
  openWatchFiringThread(
    callerId: string,
    input: OpenWatchFiringThreadInput,
  ): Promise<WatchFiringThread>;
}

/**
 * How long a firing waits for an agent that is on its way.
 *
 * The backend is re-resolved rather than held, so swapping the assigned model
 * takes it away and puts it back — measured at around twenty seconds on the
 * operator's install. A firing landing inside that window used to ship as the
 * plain banner, which is the worse notification for a reason that had already
 * stopped being true by the time it arrived. Waiting costs a delivery that is
 * already asynchronous a few seconds; not waiting costs the conversation.
 *
 * Bounded well under the swap, not over it — and spent at most once while the
 * agent stays away, which is the other half of the same rule: an install with
 * no agent at all must not stall every firing it ever has for a swap that is
 * never going to complete. See {@link createWatchFiringThreadOpener}.
 */
export const WATCH_FIRING_AGENT_WAIT_MS = 5_000;

/** How often the wait re-asks. Short enough that the wait is mostly the swap. */
const AGENT_POLL_INTERVAL_MS = 250;

/**
 * There is no agent to open a conversation with.
 *
 * Distinguished from every other failure so the delivery row can say which of
 * the two happened: an install that never had an agent, and one whose agent
 * was mid-swap or refused the turn. They read identically in a log and are
 * different problems.
 */
export class WatchFiringThreadNoAgentError extends Error {
  constructor() {
    super("no agent is configured on this gateway");
    this.name = "WatchFiringThreadNoAgentError";
  }
}

export interface WatchFiringThreadOpenerDeps {
  /** `null` on a gateway with no agent configured. */
  getAgent: () => WatchFiringThreadAgentPort | null;
  /** How long to wait for an absent agent. Defaults to the constant above. */
  agentWaitMs?: number;
  /** Injected so a test does not spend the wait it is asserting on. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for an agent to appear, or give up. Returns immediately when one is.
 *
 * `waiting` is the opener's memory of whether the budget is still worth
 * spending. A swap is a gap between two agents, so waiting one out is worth a
 * few seconds; an install with no agent is not a gap at all, and paying the
 * budget on every firing forever is the stall this is bounded to avoid. So the
 * budget is spent once, and not again until an agent has actually been seen.
 */
async function resolveAgent(
  deps: WatchFiringThreadOpenerDeps,
  waiting: { worthIt: boolean },
): Promise<WatchFiringThreadAgentPort | null> {
  // Asked once before any waiting: the ordinary case is an agent that is
  // already there, and it must not pay for the case that is not.
  let agent = deps.getAgent();
  if (agent !== null) {
    // Seen. The next gap is a gap rather than an absence, and worth waiting on.
    waiting.worthIt = true;
    return agent;
  }
  if (!waiting.worthIt) return null;

  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const budget = deps.agentWaitMs ?? WATCH_FIRING_AGENT_WAIT_MS;
  for (let waited = 0; waited < budget; waited += AGENT_POLL_INTERVAL_MS) {
    await sleep(AGENT_POLL_INTERVAL_MS);
    agent = deps.getAgent();
    if (agent !== null) return agent;
  }
  // Waited the whole budget and nothing came. Every firing behind this one
  // goes straight to the plain banner until an agent turns up.
  waiting.worthIt = false;
  return null;
}

/**
 * Build the opener the iOS-push delivery adapter calls.
 *
 * Every failure is a rejection, never a silent null: the adapter degrades a
 * firing to its plain notification on rejection, and a null return would be
 * indistinguishable from "there was nothing to open".
 */
export function createWatchFiringThreadOpener(
  deps: WatchFiringThreadOpenerDeps,
): (input: WatchFiringThreadRequest) => Promise<WatchFiringThread> {
  // Held across firings, which is why the composition root builds this once
  // rather than per delivery: an opener rebuilt for every firing would forget
  // that it had already waited, and an agentless install would pay the budget
  // on every one of them.
  //
  // Starts true so a gateway whose agent is still arriving at boot — the case
  // this whole wait exists for — gets its one wait.
  const waiting = { worthIt: true };
  return async (request) => {
    const agent = await resolveAgent(deps, waiting);
    if (!agent) throw new WatchFiringThreadNoAgentError();
    // Keyed on the firing's full identity, not the watch and not the sequence
    // number: one tick can fire several times over different evidence, and a
    // thread reused across two of them would tell the operator about an event
    // that is not the one the banner is announcing.
    const existing = await agent.findWatchFiringThread(request.firingId);
    if (existing) return existing;
    return agent.openWatchFiringThread(WATCH_FIRING_CALLER_ID, {
      firingId: request.firingId,
      watchId: request.watchId,
      watchName: request.watchName,
      condition: request.condition,
      firedAt: request.firedAt,
      evidenceDocumentIds: request.evidenceDocumentIds,
    });
  };
}

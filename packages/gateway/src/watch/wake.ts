// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch firing, handed to the apparatus that wakes an agent safely.
 *
 * Third application of the same move: keep the tail, swap the engine. Here the
 * tail is considerably more than a transport. Waking an agent means an
 * approval and a grant, a short-lived answer authority scoped to one firing, a
 * privacy reviewer deciding what that agent may learn, and an egress ledger
 * recording what it was told. All of that exists, and none of it is a watch's
 * business.
 *
 * So a V2 watch that wants to wake an agent keeps a **delivery anchor** among
 * the subscriptions — minted once when the watch declares `agent-wake` — and a
 * firing is reported into it. From that point the existing drain claims it,
 * sends the wake, mints the authority, and answers the agent's questions
 * through the gate. Nothing here talks to a harness, and no envelope changes:
 * the wake an agent receives is the one it already understands.
 *
 * **What crosses to the agent, and what does not.** The wake carries opaque
 * identifiers and the operator's instruction — never the firing's payload. The
 * agent then asks what caused the firing, and that question is answered by a
 * turn that reads the firing's evidence and researches the corpus, whose reply
 * passes the reviewer and lands in the egress ledger. So the payload does
 * travel, but only along that path: recorded with the firing as what the plan
 * observed, and released, if at all, as a reviewed answer. Putting it in the
 * wake instead would route corpus content around the reviewer and the ledger,
 * which are the reason any of this is safe.
 */

import { createLogger, type Logger } from "@omnesis/core";
import type { WatchV2EvidenceKind } from "../subscriptions/watch-v2-plan.js";
import type { WatchDeliveryOutcome, WatchDeliveryPort, WatchNotification } from "./engine-host.js";

const log: Logger = createLogger("gateway").child("watch-v2:wake");

/** What reporting a firing into its anchor requires. */
export interface WatchWakeAnchorPort {
  /**
   * The anchor a watch wakes through, or null when it has none — a watch whose
   * integration was never connected, or whose anchor was retired with it.
   */
  anchorFor(
    watchId: string,
  ): { subscriptionId: string; revision: number; evidence: WatchV2EvidenceKind } | null;
  /**
   * Report the firing. Resolves to whether it became a live firing: a repeat of
   * one already recorded is discarded by the anchor's own uniqueness, which is
   * what makes a replayed firing wake nobody twice.
   */
  fire(input: {
    subscriptionId: string;
    revision: number;
    /**
     * The firing's full identity — stable per firing, and *distinct* between
     * two firings of one tick. Anything coarser makes a fan-out's second arm
     * indistinguishable from a replay of its first.
     */
    eventKey: string;
    evidenceDocumentIds: readonly string[];
    /**
     * What the plan observed satisfying the condition, for a firing that
     * carries no documents. Recorded with the firing rather than recovered
     * later: the same query run when the agent finally asks can return a
     * different row, or none, and an answer built on it would describe a
     * different occurrence than the one that woke anybody.
     */
    observation?: Record<string, unknown>;
    firedAt: number;
  }): Promise<{ fired: boolean }>;
}

/**
 * Deliver by waking an agent.
 *
 * The `delivered` this reports is whether a firing was *recorded* for delivery,
 * not whether an agent read it. The wake is claimed asynchronously by a drain
 * that owns its own retries and backoff, and a host that waited for the agent
 * would be holding an evaluation pass open across a network call to another
 * machine.
 */
export function agentWakeDelivery(getAnchors: () => WatchWakeAnchorPort | null): WatchDeliveryPort {
  return {
    async send(notification: WatchNotification): Promise<WatchDeliveryOutcome> {
      const anchors = getAnchors();
      if (!anchors) {
        log.warn(`watch ${notification.watchName} fired but no agent integration is wired`);
        return { delivered: 0, attempted: 0, error: "no agent integration is wired" };
      }
      const anchor = anchors.anchorFor(notification.watchId);
      if (!anchor) {
        // Said rather than swallowed: a watch asking to wake an agent that has
        // no anchor will never wake one, and the silence is indistinguishable
        // from an agent that read the wake and did nothing about it.
        log.warn(
          `watch ${notification.watchName} asks to wake an agent but has no anchor — nothing was sent`,
        );
        return {
          delivered: 0,
          attempted: 0,
          error: "this watch has no anchor, so no agent can be woken for it",
        };
      }

      const firedAt = Date.parse(notification.firedAt);
      const result = await anchors.fire({
        subscriptionId: anchor.subscriptionId,
        revision: anchor.revision,
        // The firing's **full identity**, not its deep-link key.
        //
        // The anchor is unique on `(subscription, revision, eventKey)`, and a
        // broadcast arm re-judges every live cell at the tick's own sequence
        // number — so several firings, about different evidence, share a
        // `watchId:seq`. Keyed on that, the first arm of a fan-out wakes the
        // agent and every other arm is discarded as a replay: not delayed, not
        // logged as lost, simply never delivered.
        //
        // The four-component id keeps the guard the anchor's own uniqueness
        // rather than a second one invented here: the same firing reported
        // twice still produces the same string and still collides. The thread
        // opener already keys on this for the same reason.
        eventKey: notification.firingId,
        // What the agent may read when it asks what caused this, bounded by
        // what the anchor was approved to offer. A condition-only anchor
        // carries no documents by construction, and a firing that arrived with
        // some — a watch reclassified under a newer build, say — must lose them
        // here rather than release corpus content against an approval that
        // never admitted any.
        evidenceDocumentIds: anchor.evidence === "documents" ? notification.documentIds : [],
        // The mirror image of the line above. Where documents are the
        // evidence they already say what happened; where there are none, this
        // is the only account of the occurrence that will ever exist, and
        // without it the agent can be told nothing but that a threshold moved.
        ...(anchor.evidence === "documents" ? {} : { observation: notification.payload }),
        firedAt: Number.isFinite(firedAt) ? firedAt : Date.now(),
      });
      if (!result.fired) {
        log.info(`watch ${notification.watchName}: ${notification.firingId} was already reported`);
        // Not a failure: the anchor's own uniqueness discarded a replay, which
        // is what stops one firing waking an agent twice.
        return { delivered: 0, attempted: 1 };
      }
      return { delivered: 1, attempted: 1 };
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch firing, delivered down the notification tail that already exists.
 *
 * The tail is not this module's to reinvent. `NotifyRunner` already knows which
 * devices are registered, how to select their transports, what to do about a
 * token a device has thrown away, and how to record what it sent. None of that
 * is a watch's business, and a second implementation of it would be a second
 * thing to keep correct.
 *
 * So this module is a translation and nothing else: a watch firing becomes the
 * shape the runner takes. The caps live upstream in the host, because whether a
 * person should be interrupted is a question about the watch rather than about
 * the transport.
 */

import { createLogger, type Logger } from "@omnesis/core";
import { watchFiringPushCopy } from "../agent/watch-firing-thread.js";
import { WatchFiringThreadNoAgentError } from "./firing-thread.js";
import type {
  WatchDeliveryOutcome,
  WatchDeliveryPort,
  WatchNotification,
  WatchThreadDegrade,
} from "./engine-host.js";
import type { NotifyRunOptions, NotifyRunResult } from "./notify-runner.js";

const log: Logger = createLogger("gateway").child("watch-v2:delivery");

/** What the opener needs to ask the agent for a conversation about a firing. */
export interface WatchFiringThreadRequest {
  readonly watchId: string;
  /** The firing itself — the thread's durable anchor, and its dedup key. */
  readonly firingId: string;
  /** The watch's operator-facing name, which titles the thread. */
  readonly watchName: string;
  /** What the operator asked to be told about, in their own words. */
  readonly condition: string;
  readonly firedAt: number;
  /** The documents that made the firing true. */
  readonly evidenceDocumentIds: readonly string[];
}

/** An agent-opened conversation about a firing. */
export interface WatchFiringThread {
  conversationId: string;
  /** The agent's first message — what the notification quotes. */
  openingMessage: string;
}

/**
 * The part of the notification runner a watch needs.
 *
 * Structural rather than the class itself, so this can be driven in a test
 * without a carrier client, a device table or a network — and so the dependency
 * points at a shape this module states rather than at whatever the runner
 * happens to expose.
 */
export interface WatchPushRunner {
  run(input: NotifyRunOptions): Promise<NotifyRunResult>;
}

/**
 * Deliver through the runner, or report that there is nowhere to deliver.
 *
 * `getRunner` is a thunk so delivery always uses the host's current push
 * wiring rather than a captured runner that may have been replaced.
 */
export function omnesisNotifyDelivery(
  getRunner: () => WatchPushRunner | null,
  openThread?: (request: WatchFiringThreadRequest) => Promise<WatchFiringThread>,
): WatchDeliveryPort {
  return {
    async send(notification: WatchNotification): Promise<WatchDeliveryOutcome> {
      const runner = getRunner();
      if (!runner) {
        log.warn(`watch ${notification.watchName} fired but no push transport is wired`);
        return { delivered: 0, attempted: 0, error: "no push transport is configured" };
      }

      // The agent opens a conversation about the firing and writes its first
      // message; the banner then quotes that message and a tap lands on the
      // thread. When no thread can be written the firing still goes out as the
      // plain notification — a firing is never lost to a conversation that
      // failed to open. Asked for even when the author wrote their own copy:
      // the conversation is the thing a tap opens, not just a source of words.
      const opened = await openFiringThread(openThread, notification);
      const thread = opened.thread;
      // Words the author wrote outrank both the composed default and the
      // agent's account: a watch whose banner text somebody chose says that,
      // or the feature has quietly answered a different question.
      const written = thread
        ? watchFiringPushCopy(notification.watchName, thread.openingMessage)
        : { title: notification.title, body: notification.body };
      const title = notification.authoredCopy.title ?? written.title;
      const body = notification.authoredCopy.body ?? written.body;

      const result = await runner.run({
        watchId: notification.watchId,
        watchName: notification.watchName,
        firingKey: notification.firingKey,
        firingId: notification.firingId,
        title,
        body,
        // One banner per line of the ledger, replacing rather than stacking.
        // Deliberately the deep-link key and not the firing's full identity:
        // several firings can share a `seq`, and what the operator gets from
        // them is one banner pointing at the line all of them are on.
        collapseId: notification.firingKey,
        // What a tap deep-links to. A firing the agent wrote about lands in
        // that conversation — the thread whose opening sentence this banner is
        // quoting — and one it did not lands on the watch and the line of its
        // ledger, which is all there is to show.
        ...(thread === null ? {} : { conversationId: thread.conversationId }),
      });

      if (result.delivered === 0) {
        // Not an error here. A gateway with no registered device, or none with
        // a live push registration, is an ordinary state — and the host counts
        // what was delivered rather than what was attempted, so the difference is
        // already visible in the report. Nothing re-sends: the firing's row is
        // committed and the cursor is past it, so a rejected push is a log
        // line and a number in the report, not a queued retry.
        log.warn(
          `watch ${notification.watchName}: nothing accepted the push (${result.attempted} device(s) attempted)`,
        );
      }
      return {
        delivered: result.delivered,
        attempted: result.attempted,
        ...(result.error === null ? {} : { error: result.error }),
        // Recorded on the row rather than left in a log line. A degraded
        // delivery is a success by every count on it — attempted, delivered —
        // so this is the only place that can say the operator got the lesser
        // notification, and the only way to count how often that happens.
        ...(opened.degraded === undefined ? {} : { degraded: opened.degraded }),
      };
    },
  };
}

/**
 * Ask for a conversation about the firing, or say why there will not be one.
 *
 * Every failure degrades rather than propagates: no agent configured, a
 * backend that is down, a turn that ends saying nothing. The operator asked to
 * be told when their watch came true, and being told plainly beats not being
 * told at all.
 *
 * The degrade class comes back with the answer rather than being left in a log
 * line. A bare `null` says only that there is no thread, which reads the same
 * whether the install has no agent or the one it has just refused — and the
 * caller writes that answer to a row somebody reads later.
 */
async function openFiringThread(
  open: ((request: WatchFiringThreadRequest) => Promise<WatchFiringThread>) | undefined,
  notification: WatchNotification,
): Promise<{ thread: WatchFiringThread | null; degraded?: WatchThreadDegrade }> {
  if (!open) return { thread: null, degraded: "no-opener" };
  try {
    const thread = await open({
      watchId: notification.watchId,
      firingId: notification.firingId,
      watchName: notification.watchName,
      condition: notification.condition,
      firedAt: Date.parse(notification.firedAt),
      evidenceDocumentIds: notification.documentIds,
    });
    return { thread };
  } catch (err) {
    // The message goes to the log, which is on-host and rotates; the row keeps
    // only the class. A backend's error text can quote the corpus, and the row
    // outlives the log.
    log.warn(
      `firing ${notification.firingId} falls back to the plain push: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      thread: null,
      degraded: err instanceof WatchFiringThreadNoAgentError ? "no-agent" : "open-failed",
    };
  }
}

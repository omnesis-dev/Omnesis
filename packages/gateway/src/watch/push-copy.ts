// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The default words a watch firing goes out with.
 *
 * An APNs alert body reaches Apple in plaintext and renders on a locked device,
 * so what goes in it is a privacy decision before it is a copy decision. The
 * default made here is conservative: the banner says **what the operator asked
 * to be told about**, and nothing about what the watch found.
 *
 * The prose is the operator's own — the request the watch was written from, or
 * failing that its name, both of which they wrote. No part of the firing's
 * payload appears, because a payload holds whatever the author's `output_map`
 * named: a subject line, a correspondent, an amount. Those would be corpus text
 * leaving the host without anyone having asked for it.
 *
 * That has a cost, and it is worth naming: the person is told that the thing
 * happened, not what it was, and has to open the app to find out.
 *
 * **This is the default, not the last word.** On a gateway with an agent, the
 * delivery port asks the agent to open a conversation about the firing and
 * sends its opening sentence instead — which does put corpus-derived prose on
 * the lock screen. See `omnesisNotifyDelivery` and `watchFiringPushCopy` for what
 * that widens and what bounds it. Copy the author wrote by hand always wins
 * over both, which is why {@link WatchNotificationCopy} reports which fields
 * were chosen rather than composed.
 */

import { MAX_PUSH_BODY_CHARS } from "../agent/watch-firing-thread.js";
import type { WatchDefinition } from "@omnesis/watch";

export interface WatchNotificationCopy {
  /** What to show, author's words where they wrote any. */
  readonly title: string;
  readonly body: string;
  /**
   * The fields the author chose, verbatim.
   *
   * Reported separately because "the operator wrote this body" and "the runtime
   * composed this body from their request" are the same string type and
   * different decisions: only the second may be replaced by an agent's account
   * of the firing.
   */
  readonly authored: { readonly title?: string; readonly body?: string };
}

export function watchNotificationCopy(watch: WatchDefinition): WatchNotificationCopy {
  const chosen = watch.delivery?.kind === "omnesis-notify" ? watch.delivery : undefined;
  const asked = watch.nl_query?.replace(/\s+/g, " ").trim();
  const body =
    asked && asked.length > 0
      ? clip(asked)
      : // A watch with no request behind it is one someone hand-wrote, and its
        // name is the closest thing to a sentence they gave it.
        `${watch.name} fired`;
  return {
    title: chosen?.title ?? "Omnesis",
    body: chosen?.body === undefined ? body : clip(chosen.body),
    authored: {
      ...(chosen?.title === undefined ? {} : { title: chosen.title }),
      ...(chosen?.body === undefined ? {} : { body: clip(chosen.body) }),
    },
  };
}

/** Clip to what a banner shows, and mark the cut so it reads as an opening. */
function clip(text: string): string {
  return text.length <= MAX_PUSH_BODY_CHARS
    ? text
    : `${text.slice(0, MAX_PUSH_BODY_CHARS - 1).trimEnd()}…`;
}

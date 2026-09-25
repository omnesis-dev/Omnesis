// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The briefs push tier — deliberately tiny. The feed absorbs everything;
 * push exists only for the one thing worth interrupting for, and v1 that
 * is exactly the morning digest: at most one notification per day, sent
 * when the digest run lands its brief. This module only shapes the
 * message; delivery discipline (never throws, short-circuits, per-device
 * isolation, gone-token clearing) lives in the shared push broadcaster.
 */

import type { Logger } from "@omnesis/core";
import type { BriefRow } from "./storage/types.js";
import type { NotificationPublisher } from "../push/broadcast.js";

export interface DigestPushDeps {
  publisher: NotificationPublisher;
}

/**
 * Push one digest brief to every registered notification device. `day` keys the
 * collapse id so a same-day recompose replaces the banner instead of
 * stacking it. Never throws — a push failure must not fail (or retry)
 * the digest run that minted the brief.
 */
export async function sendDigestPush(
  deps: DigestPushDeps,
  brief: Pick<BriefRow, "id" | "title" | "description">,
  day: string,
  log?: Pick<Logger, "warn">,
): Promise<void> {
  try {
    await deps.publisher.publish({
      kind: "brief",
      title: brief.title,
      body: brief.description,
      data: { briefId: brief.id },
      collapseId: `digest:${day}`,
    });
  } catch (err) {
    // The digest run is already settled `completed` by the time this is
    // reached, and it executes in the drainer's SERIAL lane — so a throw here
    // would abandon the runs claimed alongside it in the same tick, each with
    // an attempt burned against work that never ran. A missed notification is
    // the smaller loss: the brief itself is in the feed either way.
    log?.warn(
      `digest push failed for brief ${brief.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

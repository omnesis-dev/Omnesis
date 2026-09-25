// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a watch's firings can offer an agent the documents behind them.
 *
 * The classification is made once, when the watch's anchor is minted, and it
 * has to hold for every firing that watch will ever produce. It is a statement
 * about what a firing **may** carry, not what each one will: a watch that is
 * true either when a message arrives or when a deadline passes has documents
 * behind the first and nothing behind the second, and both are correct.
 *
 * So the question asked is whether *any* source the sink can reach is a
 * document source. Answering `condition-only` for such a watch would be a
 * promise the store then enforces — a condition-only firing may not carry
 * documents — and every document firing it made would have to be stripped.
 */

import { nodeInputs, type WatchDefinition, type WatchNode } from "@omnesis/watch";
import type { WatchV2EvidenceKind } from "../subscriptions/watch-v2-plan.js";

/** Node types instantiated by the journal rather than by another node. */
function isSource(node: WatchNode): boolean {
  return node.type.startsWith("source.");
}

/**
 * The sources a sink can be reached from, following inputs backwards.
 *
 * Walked from the sink rather than over every node in the watch: a definition
 * may carry a node nothing downstream reads — the validator warns about it but
 * does not refuse it — and such a node cannot contribute to a firing, so it
 * must not decide what a firing can offer.
 */
export function reachableSources(watch: WatchDefinition): WatchNode[] {
  const byId = new Map(watch.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const sources: WatchNode[] = [];
  const queue = [watch.sink.input];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (isSource(node)) {
      sources.push(node);
      continue;
    }
    for (const input of Object.keys(nodeInputs(node))) queue.push(input);
  }
  return sources;
}

/**
 * What a watch's firings may hand an agent.
 *
 * A watch with no reachable source at all is condition-only: it cannot fire,
 * and a classification that admitted documents would be a claim about firings
 * that will never happen.
 */
export function wakeEvidenceKind(watch: WatchDefinition): WatchV2EvidenceKind {
  return reachableSources(watch).some((node) => node.type === "source.document_event")
    ? "documents"
    : "condition-only";
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain's own system sources: the wiki projections and the open-loop
 * mirror. They have display rows in `sync_state` like the gateway's other
 * internal datasets, but they belong to an experimental feature, so a gateway
 * with experimental mode off lists neither — including a row an earlier boot,
 * or an earlier experimental run, left behind.
 */

import { experimentalVisible } from "@omnesis/core";
import { KNOWLEDGE_SOURCE_ID } from "./knowledge/source-meta.js";
import { OPEN_LOOP_SOURCE_ID } from "./open-loop-source/source-meta.js";

const BRAIN_SYSTEM_SOURCE_IDS: readonly string[] = [KNOWLEDGE_SOURCE_ID, OPEN_LOOP_SOURCE_ID];

/** Whether a source id is one of the Brain's, hidden while experimental mode is off. */
export function isHiddenBrainSource(sourceId: string): boolean {
  return BRAIN_SYSTEM_SOURCE_IDS.includes(sourceId) && !experimentalVisible();
}

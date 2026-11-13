// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SOURCE_SCOPE_EDITOR_READS } from "../access/scope-editor-reads.js";
import { ANSWER_HISTORY_READS } from "../privacy/context-reads.js";
import { STATUS_CACHE_READS } from "../http/services/status-cache-reads.js";
import { ANALYTICS_REPLICA_READS } from "../http/services/analytics-replica-reads.js";
import { KNOWLEDGE_ENGINE_READS } from "../brain/knowledge/selection-reads.js";
import { COLLISION_SWEEP_READS } from "../brain/rhythm/collision-sweep-reads.js";
import { mergeReadPorts } from "./read-port.js";

/**
 * Every read port the io worker serves (`read-port.ts`). `io-handlers.ts` and
 * `io-ops.ts` register this whole set, so a new port is one argument here.
 */
export const IO_READS = mergeReadPorts(
  STATUS_CACHE_READS,
  SOURCE_SCOPE_EDITOR_READS,
  ANSWER_HISTORY_READS,
  KNOWLEDGE_ENGINE_READS,
  ANALYTICS_REPLICA_READS,
  COLLISION_SWEEP_READS,
);

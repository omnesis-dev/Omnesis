// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway implementation of the agent's read-only `EntityContextPort` — the
 * adapter behind the `entity_context` reap tool. Reaps the cognitive
 * neighbourhood around a seed entity directly on the provided handle (like the
 * loop-read / temporal ports), with no writer round-trip. Shared by the
 * interactive agent (chat) and the background Cognition Steward.
 */

import { reapEntityContext } from "./CognitiveGraphService.js";
import type Database from "better-sqlite3";
import type { EntityContextPort, EntityContextResult, EntityContextSeed } from "@omnesis/agent";

type Db = Database.Database;

export function createGatewayEntityContextPort(db: Db): EntityContextPort {
  return {
    async reap(seed: EntityContextSeed, opts): Promise<EntityContextResult> {
      return reapEntityContext(db, seed, { depth: opts?.depth });
    },
  };
}

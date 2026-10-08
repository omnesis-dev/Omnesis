// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AsyncLocalStorage } from "node:async_hooks";
import { maintenanceCanonicalWriteGate, type WriteGate } from "../../write-gate.js";
import { captureKnowledgeCanonicalFence, type KnowledgeCanonicalFence } from "./canonical-fence.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";
import type { ToolHandle } from "@omnesis/agent";
import type { KnowledgeRunFence } from "./run-fence.js";

/** Invocation-local scope survives verifier awaits without sharing mutable run state. */
export function buildMaintenanceCanonicalTools(
  db: Database.Database,
  gate: WriteGate,
  run: KnowledgeRunFence,
  build: (gate: WriteGate) => ToolHandle[],
): ToolHandle[] {
  const scope = new AsyncLocalStorage<KnowledgeCanonicalFence>();
  const scoped = maintenanceCanonicalWriteGate(gate, () => {
    const fence = scope.getStore();
    if (!fence)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical maintenance write has no offered input",
      );
    return fence;
  });
  return build(scoped).map((tool) =>
    !tool.mutates
      ? tool
      : {
          ...tool,
          async invoke(args, context) {
            try {
              const fence = captureKnowledgeCanonicalFence(db, run, args, tool.name);
              return await scope.run(fence, () => tool.invoke(args, context));
            } catch (error) {
              if (error instanceof KnowledgeStorageError)
                return { kind: "error" as const, code: error.code, message: error.message };
              throw error;
            }
          },
        },
  );
}

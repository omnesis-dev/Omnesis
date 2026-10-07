// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AsyncLocalStorage } from "node:async_hooks";
import { maintenanceCanonicalWriteGate, type WriteGate } from "../../write-gate.js";
import { TemporalReconciliation } from "./temporal-reconciliation.js";
import {
  captureKnowledgeCanonicalFence,
  knowledgeCanonicalOwnerVersion,
  type KnowledgeCanonicalFence,
} from "./canonical-fence.js";
import {
  assertKnowledgeReconciliation,
  readKnowledgeCollectionRevision,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type { KnowledgeRunFence } from "./run-fence.js";
import type { KnowledgeOwnerKind } from "./owner-adapters.js";

function ownerKind(tool: string, args: unknown): KnowledgeOwnerKind | undefined {
  if (tool.startsWith("open_loop_")) return "loop";
  if (tool.startsWith("brief_")) return "brief";
  if (tool === "annotation_search")
    return args &&
      typeof args === "object" &&
      "personId" in args &&
      typeof args.personId === "string"
      ? "person_annotation"
      : "doc_annotation";
  if (tool.startsWith("person_annotation_") || tool === "annotate_person")
    return "person_annotation";
  if (tool.startsWith("annotation_") || tool === "annotate_durable") return "doc_annotation";
  return undefined;
}
const reconciliationReads = new Set(["open_loop_search", "brief_list", "annotation_search"]);
const ownerReads = new Set([...reconciliationReads, "open_loop_fetch", "brief_fetch"]);
const creates = new Set([
  "open_loop_create",
  "brief_create",
  "annotate_durable",
  "annotate_person",
]);
function returnedOwnerIds(result: ToolResult): string[] {
  if (result.kind !== "structured" || !result.data || typeof result.data !== "object") return [];
  const data = result.data as Record<string, unknown>;
  const rows = data.loops ?? data.briefs ?? data.annotations ?? [data];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) =>
    row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : [],
  );
}

/** Invocation-local scope survives verifier awaits without sharing mutable run state. */
export function buildMaintenanceCanonicalTools(
  db: Database.Database,
  gate: WriteGate,
  run: KnowledgeRunFence,
  build: (gate: WriteGate) => ToolHandle[],
  options: { parallel?: boolean } = {},
): ToolHandle[] {
  const scope = new AsyncLocalStorage<KnowledgeCanonicalFence>();
  const temporal = new TemporalReconciliation();
  const owners = new Map<string, string | null>();
  const annotationSubjects = new Map<string, KnowledgeReconciliationReceipt>();
  const collections = new Map<KnowledgeOwnerKind, KnowledgeReconciliationReceipt>();
  const key = (kind: KnowledgeOwnerKind, id: string) => `${kind}:${id}`;
  const scoped = maintenanceCanonicalWriteGate(gate, () => {
    const fence = scope.getStore();
    if (!fence)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical maintenance write has no offered input",
      );
    return fence;
  });
  return build(scoped)
    .filter((tool) => !options.parallel || tool.name !== "notes_rewrite")
    .map((tool) => ({
      ...tool,
      async invoke(args, context) {
        try {
          const kind = ownerKind(tool.name, args);
          if (!tool.mutates) {
            if (options.parallel && tool.name === "temporal_query")
              return await temporal.read(db, () => tool.invoke(args, context));
            if (!options.parallel || !kind || !ownerReads.has(tool.name))
              return await tool.invoke(args, context);
            // Search may await the index after reading canonical rows. Never bless those
            // earlier rows by taking the receipt only after its asynchronous return.
            const receipt = {
              collection: kind,
              revision: readKnowledgeCollectionRevision(db, kind),
            };
            const result = await tool.invoke(args, context);
            if (result.kind !== "structured") return result;
            db.transaction(() => {
              assertKnowledgeReconciliation(db, receipt);
              for (const id of returnedOwnerIds(result))
                owners.set(key(kind, id), knowledgeCanonicalOwnerVersion(db, kind, id));
              if (reconciliationReads.has(tool.name)) collections.set(kind, receipt);
              if (
                tool.name === "annotation_search" &&
                result.data &&
                typeof result.data === "object"
              ) {
                const field = kind === "person_annotation" ? "personId" : "docId";
                const input =
                  args && typeof args === "object" ? (args as Record<string, unknown>) : {};
                const output = result.data as Record<string, unknown>;
                for (const subject of [input[field], output[field]])
                  if (typeof subject === "string")
                    annotationSubjects.set(key(kind, subject), receipt);
              }
            })();
            return result;
          }
          const fence = captureKnowledgeCanonicalFence(db, run, args, tool.name);
          if (options.parallel) {
            if (
              [
                "temporal_annotation_add",
                "temporal_annotation_update",
                "temporal_annotation_delete",
              ].includes(tool.name)
            )
              fence.collections = [
                temporal.require(
                  tool.name === "temporal_annotation_add"
                    ? undefined
                    : args &&
                        typeof args === "object" &&
                        "annotationId" in args &&
                        typeof args.annotationId === "string"
                      ? args.annotationId
                      : "",
                ),
              ];
            for (const owner of fence.owners) {
              const version = owners.get(key(owner.kind, owner.id));
              if (version === undefined)
                throw new KnowledgeStorageError(
                  "revision_conflict",
                  "Fetch or search this canonical owner before revising it.",
                );
              owner.version = version;
            }
            const subjectField =
              tool.name === "annotate_person"
                ? "personId"
                : tool.name === "annotate_durable"
                  ? "docId"
                  : undefined;
            const subject =
              subjectField && args && typeof args === "object"
                ? (args as Record<string, unknown>)[subjectField]
                : undefined;
            const receipt = kind
              ? subjectField
                ? typeof subject === "string"
                  ? annotationSubjects.get(key(kind, subject))
                  : undefined
                : collections.get(kind)
              : undefined;
            if (kind && creates.has(tool.name) && !receipt)
              throw new KnowledgeStorageError(
                "revision_conflict",
                "Search or list the existing owners before creating one; annotations require annotation_search for the same subject.",
              );
            if (receipt) fence.collections = [{ ...receipt }];
            if (tool.name === "brief_create" && args && typeof args === "object") {
              const input = args as Record<string, unknown>;
              fence.briefCreateGuard = {
                loopIds: Array.isArray(input.relatedLoopIds)
                  ? input.relatedLoopIds.filter((id): id is string => typeof id === "string")
                  : [],
                supersedes: Array.isArray(input.supersedes)
                  ? input.supersedes.filter((id): id is string => typeof id === "string")
                  : [],
                force: input.force === true,
              };
            }
          }
          const priorCollections = fence.collections?.map((receipt) => ({ ...receipt }));
          let result: ToolResult | undefined;
          try {
            result = await scope.run(fence, () => tool.invoke(args, context));
            return result;
          } finally {
            // The gate replaces these only with metadata returned by its writer
            // transaction. A later mirror await cannot acknowledge unseen writes.
            if (options.parallel) {
              temporal.acceptOwnWrite(fence.collections, result);
              for (const receipt of fence.collections ?? []) {
                const prior = priorCollections?.find(
                  (entry) => entry.collection === receipt.collection,
                );
                if (!prior) continue;
                for (const [subject, observed] of annotationSubjects)
                  if (
                    observed.collection === receipt.collection &&
                    observed.revision === prior.revision
                  )
                    annotationSubjects.set(subject, receipt);
              }
              for (const owner of fence.owners)
                owners.set(key(owner.kind, owner.id), owner.version);
              for (const receipt of fence.collections ?? [])
                if (receipt.collection !== "wiki" && receipt.collection !== "temporal")
                  collections.set(receipt.collection, receipt);
            }
          }
        } catch (error) {
          if (error instanceof KnowledgeStorageError)
            return { kind: "error" as const, code: error.code, message: error.message };
          throw error;
        }
      },
    }));
}

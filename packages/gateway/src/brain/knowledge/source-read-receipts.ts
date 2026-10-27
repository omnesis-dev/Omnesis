// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { decisionPayloadErasureGeneration } from "../decision-payload.js";
import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

const completion = z.object({ id: z.string(), inputFingerprint: z.string() });
const sourceView = z
  .object({
    id: z.string(),
    contentHash: z.string(),
    sourceRevision: z.string().optional(),
    content: z.string(),
    contentTruncated: z.boolean().optional(),
  })
  .passthrough();
const frontierView = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          inputFingerprint: z.string(),
          source: sourceView.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const referenceView = z.object({ ref: z.string(), revision: z.string(), text: z.string() });
const contentRange = z.object({
  offset: z.number().int().nonnegative().safe(),
  returnedCharacters: z.number().int().nonnegative().safe(),
  totalCharacters: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
});
const MAX_READ_SOURCES = 512;
const MAX_READ_INTERVALS = 128;
const fetchArgs = z.object({ documents: z.array(z.object({ documentId: z.string() })) });

/** Run-local proof of complete source content actually returned through a tool.
 * A successor re-reads unresolved inputs; terminal coverage is already durable.
 */
export function withKnowledgeSourceReadReceipts(
  db: Database.Database,
  tools: ToolHandle[],
): ToolHandle[] {
  const readVersions = new Map<string, string>();
  const partialReads = new Map<string, { revision: string; intervals: Array<[number, number]> }>();
  let privacyGeneration = decisionPayloadErasureGeneration(db);
  const refreshPrivacy = () => {
    const current = decisionPayloadErasureGeneration(db);
    if (current !== privacyGeneration) {
      readVersions.clear();
      partialReads.clear();
      privacyGeneration = current;
    }
    return current;
  };
  const boundReads = () => {
    for (const reads of [readVersions, partialReads])
      while (reads.size > MAX_READ_SOURCES) reads.delete(reads.keys().next().value!);
  };
  const offered = new Map<string, { fingerprint: string; revision: string }>();
  const snapshot = (id: string) =>
    db
      .prepare<[string], { content: string; revision: string }>(
        `SELECT content,${knowledgeSourceRevisionSql()} AS revision FROM documents d WHERE id=?`,
      )
      .get(id);
  const record = (id: string, revision: string, text: string, generation: number) => {
    const current = snapshot(id);
    if (
      refreshPrivacy() === generation &&
      current?.revision === revision &&
      current.content === text &&
      isKnowledgeEvidenceReadable(db, id)
    ) {
      readVersions.set(id, revision);
      partialReads.delete(id);
      boundReads();
    }
  };
  const recordPage = (
    id: string,
    prior: { content: string; revision: string },
    text: string,
    rawRange: unknown,
    generation: number,
  ) => {
    const parsed = contentRange.safeParse(rawRange);
    if (!parsed.success) return;
    const range = parsed.data;
    const end = range.offset + range.returnedCharacters;
    if (
      range.totalCharacters !== prior.content.length ||
      range.returnedCharacters !== text.length ||
      !text.length ||
      end > range.totalCharacters ||
      prior.content.slice(range.offset, end) !== text
    )
      return;
    const current = snapshot(id);
    if (
      refreshPrivacy() !== generation ||
      current?.revision !== prior.revision ||
      current.content !== prior.content ||
      !isKnowledgeEvidenceReadable(db, id)
    )
      return;
    const previous = partialReads.get(id);
    const intervals: Array<[number, number]> = [
      ...(previous?.revision === prior.revision ? previous.intervals : []),
      [range.offset, end],
    ];
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    if (merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === current.content.length) {
      readVersions.set(id, prior.revision);
      partialReads.delete(id);
    } else if (merged.length <= MAX_READ_INTERVALS) {
      partialReads.set(id, { revision: prior.revision, intervals: merged });
    } else partialReads.delete(id);
    boundReads();
  };
  return tools.map((tool) => {
    if (
      ![
        "knowledge_next_frontier",
        "knowledge_reference",
        "fetch_many",
        "knowledge_discovery_complete",
      ].includes(tool.name)
    )
      return tool;
    return {
      ...tool,
      async invoke(args, context): Promise<ToolResult> {
        const generation = refreshPrivacy();
        if (tool.name === "knowledge_discovery_complete") {
          const parsed = completion.safeParse(args);
          const item = parsed.success ? offered.get(parsed.data.id) : undefined;
          // A read hint must name an actually offered source, not a guessed ID.
          // The engine still rechecks durable frontier authority at settlement.
          if (
            parsed.success &&
            parsed.data.id.startsWith("source:") &&
            (!item || item.fingerprint !== parsed.data.inputFingerprint)
          )
            return {
              kind: "error",
              code: "revision_conflict",
              message:
                "This source ID and inputFingerprint do not match a source offered in this run. Request knowledge_next_frontier and copy its exact offered id and inputFingerprint before retrying; do not substitute a search result or reconstruct an ID.",
            };
          if (
            parsed.success &&
            parsed.data.id.startsWith("source:") &&
            item &&
            (readVersions.get(parsed.data.id.slice(7)) !== item.revision ||
              snapshot(parsed.data.id.slice(7))?.revision !== item.revision ||
              !isKnowledgeEvidenceReadable(db, parsed.data.id.slice(7)))
          )
            return {
              kind: "error",
              code: "source_read_required",
              message: `Read the complete source ${JSON.stringify(parsed.data.id.slice(7))} before completing discovery. The offered excerpt is not a full read. Use fetch_many with that documentId or knowledge_reference with ${JSON.stringify(parsed.data.id)}, then retry this exact frontier. If its generation changed, request knowledge_next_frontier again.`,
            };
        }
        // Fetch results lack a required content hash. Capture it BEFORE the read,
        // then require exact returned spans and unchanged generation on return.
        const requested = tool.name === "fetch_many" ? fetchArgs.safeParse(args) : undefined;
        const before = new Map(
          requested?.success
            ? requested.data.documents.map(
                ({ documentId }) => [documentId, snapshot(documentId)] as const,
              )
            : [],
        );
        const result = await tool.invoke(args, context);
        if (tool.name === "knowledge_next_frontier" && result.kind === "structured") {
          const parsed = frontierView.safeParse(result.data);
          if (parsed.success)
            for (const item of parsed.data.items) {
              if (!item.source || item.id !== `source:${item.source.id}`) continue;
              offered.set(item.id, {
                fingerprint: item.inputFingerprint,
                revision: item.source.sourceRevision ?? item.source.contentHash,
              });
              if (!item.source.contentTruncated)
                record(
                  item.source.id,
                  item.source.sourceRevision ?? item.source.contentHash,
                  item.source.content,
                  generation,
                );
            }
          if (parsed.success) {
            refreshPrivacy();
            return {
              ...result,
              data: {
                ...parsed.data,
                items: parsed.data.items.map((item) => {
                  if (!item.source || item.id !== `source:${item.source.id}`) return item;
                  const id = item.source.id;
                  const revision = item.source.sourceRevision ?? item.source.contentHash;
                  const current = snapshot(id);
                  const available =
                    current?.revision === revision && isKnowledgeEvidenceReadable(db, id);
                  const complete = available && readVersions.get(id) === revision;
                  const partial =
                    available && partialReads.get(id)?.revision === revision
                      ? partialReads.get(id)
                      : undefined;
                  const prefix = partial?.intervals[0];
                  return {
                    ...item,
                    sourceRead: {
                      status: !available
                        ? "unavailable"
                        : complete
                          ? "complete"
                          : partial
                            ? "partial"
                            : "required",
                      ...(available && !complete
                        ? { nextOffset: prefix?.[0] === 0 ? prefix[1] : 0 }
                        : {}),
                    },
                  };
                }),
              },
            };
          }
        }
        if (tool.name === "knowledge_reference" && result.kind === "structured") {
          const batch = z
            .object({
              items: z.array(
                z.union([
                  z.object({ ok: z.literal(true), value: referenceView }),
                  z.object({ ok: z.literal(false) }),
                ]),
              ),
              deferredRefs: z.array(z.string()),
            })
            .safeParse(result.data);
          const views = batch.success
            ? batch.data.items.flatMap((item) => (item.ok ? [item.value] : []))
            : [result.data];
          for (const view of views) {
            const parsed = referenceView.safeParse(view);
            if (
              parsed.success &&
              parsed.data.ref.startsWith("source:") &&
              !parsed.data.ref.includes("#")
            )
              record(parsed.data.ref.slice(7), parsed.data.revision, parsed.data.text, generation);
          }
        }
        if (tool.name === "fetch_many" && result.kind === "document.batch")
          for (const item of result.items) {
            if (item.kind !== "document") continue;
            const prior = before.get(item.ref.documentId);
            if (
              prior &&
              item.document.id === item.ref.documentId &&
              item.document.content === prior.content
            )
              record(item.ref.documentId, prior.revision, item.document.content, generation);
            else if (
              prior &&
              item.document.id === item.ref.documentId &&
              typeof item.document.content === "string"
            )
              recordPage(
                item.ref.documentId,
                prior,
                item.document.content,
                item.document.contentRange,
                generation,
              );
          }
        return result;
      },
    };
  });
}

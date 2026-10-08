// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

const completion = z.object({ id: z.string(), inputFingerprint: z.string() });
const sourceView = z.object({
  id: z.string(),
  contentHash: z.string(),
  content: z.string(),
  contentTruncated: z.boolean().optional(),
});
const frontierView = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      inputFingerprint: z.string(),
      source: sourceView.optional(),
    }),
  ),
});
const referenceView = z.object({ ref: z.string(), revision: z.string(), text: z.string() });
const fetchArgs = z.object({ documents: z.array(z.object({ documentId: z.string() })) });

/** Run-local proof of complete source content actually returned through a tool.
 * A successor re-reads unresolved inputs; terminal coverage is already durable.
 */
export function withKnowledgeSourceReadReceipts(
  db: Database.Database,
  tools: ToolHandle[],
): ToolHandle[] {
  const readVersions = new Map<string, string>();
  const offered = new Map<string, { fingerprint: string; revision: string }>();
  const snapshot = (id: string) =>
    db
      .prepare<
        [string],
        { content: string; revision: string }
      >("SELECT content,content_hash AS revision FROM documents WHERE id=?")
      .get(id);
  const record = (id: string, revision: string, text: string) => {
    const current = snapshot(id);
    if (
      current?.revision === revision &&
      current.content === text &&
      isKnowledgeEvidenceReadable(db, id)
    )
      readVersions.set(id, revision);
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
        if (tool.name === "knowledge_discovery_complete") {
          const parsed = completion.safeParse(args);
          const item = parsed.success ? offered.get(parsed.data.id) : undefined;
          if (
            parsed.success &&
            parsed.data.id.startsWith("source:") &&
            (!item ||
              item.fingerprint !== parsed.data.inputFingerprint ||
              readVersions.get(parsed.data.id.slice(7)) !== item.revision ||
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
        // then require the exact full body and unchanged generation on return.
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
                revision: item.source.contentHash,
              });
              if (!item.source.contentTruncated)
                record(item.source.id, item.source.contentHash, item.source.content);
            }
        }
        if (tool.name === "knowledge_reference" && result.kind === "structured") {
          const parsed = referenceView.safeParse(result.data);
          if (
            parsed.success &&
            parsed.data.ref.startsWith("source:") &&
            !parsed.data.ref.includes("#")
          )
            record(parsed.data.ref.slice(7), parsed.data.revision, parsed.data.text);
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
              record(item.ref.documentId, prior.revision, item.document.content);
          }
        return result;
      },
    };
  });
}

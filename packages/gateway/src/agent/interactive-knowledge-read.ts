// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { isClaimIdentifier, parseClaimReference } from "../brain/knowledge/references.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";

const readArgs = z.object({ id: z.string().min(1), editing: z.boolean().optional() });
function pageAlias(id: string): string | null {
  if (isClaimIdentifier(id)) return `wiki:${id}`;
  try {
    const ref = parseClaimReference(id);
    return ref.kind === "wiki" && !ref.selector ? ref.raw : null;
  } catch {
    return null;
  }
}
const unavailable = (): ToolResult => ({
  kind: "error",
  code: "knowledge_read_unavailable",
  message:
    "No accessible maintained wiki/root page was available through this read surface. " +
    "Use fetch_loop for a tracked outcome, or the scoped document, people and search tools. " +
    "Use editing=true only when preparing a canonical synthesis edit.",
});

/** Normal interactive wiki reads use the existing authorized document/citation
 * pipeline. Canonical editing snapshots remain on their original tool boundary.
 * The background toolset is never passed through this adapter.
 */
export function adaptInteractiveKnowledgeReads(
  tools: readonly ToolHandle[],
  readTools: readonly ToolHandle[],
  supportsKnowledgeAliases: boolean,
  /** Maps a maintained page's search-hit document id to its `wiki:` reference. */
  pageRefForDocument?: (documentId: string) => string | null,
): ToolHandle[] {
  const fetchMany = readTools.find((tool) => tool.name === "fetch_many");
  return tools.map((tool): ToolHandle => {
    if (tool.name !== "knowledge_fetch") return tool;
    return {
      ...tool,
      description:
        "Read a maintained wiki or root page using its exact bare node ID, a wiki:<nodeId> " +
        "reference without a claim selector, or the documentId of its search hit. Normal reads return " +
        "the same document.batch result as fetch_many, including qualified knowledgeContext " +
        "and a turn-bound citation read. This does not read cited original documents. " +
        "Other record kinds use fetch_loop or scoped people/document/search tools. " +
        "Set editing=true with the bare node ID only to obtain the canonical tagged snapshot for knowledge_save; " +
        "editing results are not qualified factual answer evidence.",
      async invoke(rawArgs, context) {
        const valid = tool.schema.safeParse(rawArgs);
        if (!valid.success)
          return {
            kind: "error",
            code: "invalid_args",
            message: "Invalid knowledge read arguments",
          };
        const parsed = readArgs.safeParse(valid.data);
        if (!parsed.success) return unavailable();
        if (parsed.data.editing === true) return tool.invoke(rawArgs, context);
        if (!fetchMany || !supportsKnowledgeAliases) return unavailable();
        const documentId = pageRefForDocument?.(parsed.data.id) ?? pageAlias(parsed.data.id);
        if (!documentId) return unavailable();
        // Alias resolution itself restricts to wiki/root, applies authorization,
        // and never falls back to a raw canonical row or an arbitrary source ID.
        const result = await fetchMany.invoke({ documents: [{ documentId }] }, context);
        if (
          result.kind !== "document.batch" ||
          !result.items.some((item) => item.kind === "document")
        )
          return unavailable();
        return result;
      },
    };
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolHandle } from "@omnesis/agent";
import type Database from "better-sqlite3";

/** Gate-specific fixtures read the real profile first; receipt tests use raw tools. */
export function withPersonProfileRead(
  db: Database.Database,
  tools: ToolHandle[],
  tool: ToolHandle,
): ToolHandle {
  if (tool.name !== "annotate_person" && tool.name !== "person_annotation_revise") return tool;
  return {
    ...tool,
    async invoke(args, context) {
      const input =
        args && typeof args === "object" ? (args as { personId?: unknown; id?: unknown }) : {};
      const personId =
        typeof input.personId === "string"
          ? input.personId
          : typeof input.id === "string"
            ? db
                .prepare<
                  [string],
                  { person_id: string }
                >("SELECT person_id FROM person_annotations WHERE id=?")
                .get(input.id)?.person_id
            : undefined;
      if (personId) {
        const search = tools.find((candidate) => candidate.name === "annotation_search");
        if (!search) throw new Error("Fixture needs annotation_search in the same toolset");
        let cursor: string | undefined;
        for (let page = 0; page < 32; page++) {
          const result = await search.invoke(
            { personId, limit: 50, ...(cursor ? { cursor } : {}) },
            context,
          );
          // Unknown/hidden subjects still reach the mutation's own refusal boundary.
          if (result.kind !== "structured") break;
          const data = result.data as { nextCursor?: string | null };
          if (!data.nextCursor) break;
          cursor = data.nextCursor;
          if (page === 31) throw new Error("Fixture profile exceeds bounded read pagination");
        }
      }
      return tool.invoke(args, context);
    },
  };
}

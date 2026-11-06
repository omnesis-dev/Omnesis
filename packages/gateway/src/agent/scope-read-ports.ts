// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolPorts } from "@omnesis/agent";
import type { AnswerScopeReadObserver } from "../privacy/answer-scope.js";

/** Capture every returned document before canonical tools can expose it to a model or client. */
export function observeScopeReadPorts(
  ports: ToolPorts,
  observer?: AnswerScopeReadObserver,
): ToolPorts {
  if (!observer) return ports;
  const { search, document, documentByUrl } = ports;
  return {
    ...ports,
    ...(search
      ? {
          search: {
            ...search,
            async search(...args) {
              const result = await search.search(...args);
              observer.recordDocuments(result.results.map((ref) => ref.documentId));
              return result;
            },
          },
        }
      : {}),
    ...(document
      ? {
          document: {
            ...document,
            async fetch(...args) {
              const result = await document.fetch(...args);
              if (result) {
                const value = result.document;
                if (
                  !value ||
                  typeof value !== "object" ||
                  !("id" in value) ||
                  typeof value.id !== "string"
                )
                  throw new Error("Document provenance is unavailable.");
                observer.recordDocuments([value.id]);
              }
              return result;
            },
          },
        }
      : {}),
    ...(documentByUrl
      ? {
          documentByUrl: {
            ...documentByUrl,
            async lookup(...args) {
              const result = await documentByUrl.lookup(...args);
              if (result.ref) observer.recordDocuments([result.ref.documentId]);
              return result;
            },
          },
        }
      : {}),
  };
}

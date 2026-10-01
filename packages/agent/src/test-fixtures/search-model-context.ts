// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolResult } from "@omnesis/core";

/** Invented result carrying canonical evidence and its separate model projection. */
export function searchModelContextResult(): Extract<ToolResult, { kind: "search.results" }> {
  return {
    kind: "search.results",
    query: "equipment agreement",
    durationMs: 2,
    results: [
      {
        documentId: "doc-agreement",
        sourceType: "example-files",
        sourceId: "example-files:account",
        title: "Equipment agreement",
        snippet: "An invented equipment agreement.",
        provenance: {
          summary: "Canonical graph summary for interface and transcript readers.",
          copies: [
            {
              documentId: "doc-agreement",
              sourceId: "example-files:account",
              title: "Equipment agreement",
            },
          ],
          paths: [{ documentIds: ["doc-agreement", "doc-message"], edges: ["inbound:contains"] }],
          truncated: false,
          stopReasons: [],
          modelContext: {
            facts: ["D1 is attached to D2."],
            documents: [
              {
                ref: "D1",
                documentId: "doc-agreement",
                sourceId: "example-files:account",
                title: "Equipment agreement",
                url: "https://example.com/agreement",
              },
              {
                ref: "D2",
                documentId: "doc-message",
                sourceId: "example-messages:account",
                title: "Sharing note",
              },
            ],
            limits: [],
          },
        },
      },
    ],
  };
}

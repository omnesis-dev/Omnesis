// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Marked, type Token } from "marked";
import { KnowledgeStorageError, type KnowledgeNodeKind } from "./types.js";

/** Validate authored prose only; never normalize stored text or literal examples. */
export function assertKnowledgeMarkdown(kind: KnowledgeNodeKind, text: string): void {
  if (kind !== "wiki" && kind !== "root") return;
  const visit = (tokens: Token[]): void => {
    for (const block of tokens) {
      if (block.type === "list") {
        for (const item of block.items) visit(item.tokens);
      } else if ((block.type === "paragraph" || block.type === "text") && block.tokens) {
        let prefix = "";
        for (const inline of block.tokens) {
          if (inline.type === "text") {
            for (const match of inline.raw.matchAll(/<#{1,6}(?=[ \t]|$)/g)) {
              const before = prefix + inline.raw.slice(0, match.index);
              if (/^ {0,3}$/.test(before.slice(before.lastIndexOf("\n") + 1)))
                throw new KnowledgeStorageError(
                  "claim_invalid",
                  'Malformed Markdown heading: use "## Heading", not "<## Heading", inside claim tags. Escape the angle bracket or use inline/fenced code for a literal example.',
                );
            }
          }
          prefix += inline.raw;
        }
      }
      // Code, HTML, block quotes and unknown layouts remain literal here.
    }
  };
  visit(new Marked().lexer(text));
}

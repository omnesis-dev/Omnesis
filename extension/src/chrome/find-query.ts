// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type FindMode = "direct" | "agentic";

/** Routing commands apply only at the start; the remaining text stays a search query. */
export function parseFindQuery(value: string): { text: string; mode?: FindMode } {
  const text = value.trim();
  const command = /^\/(search|agent)(?:\s+|$)/i.exec(text);
  if (!command) return { text };
  return {
    text: text.slice(command[0].length).trim(),
    mode: command[1]!.toLowerCase() === "search" ? "direct" : "agentic",
  };
}

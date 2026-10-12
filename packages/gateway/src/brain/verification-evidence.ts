// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Preserve source framing around selected quotes. Callers must first validate
 * source readability and quote membership; this helper grants no access.
 */
export function contextualEvidence(quote: string, source: string): string {
  if (source.trim() === quote.trim()) return quote;
  if (source.length <= 3_000)
    return JSON.stringify({ quote, source_context: source, truncated: false });
  const position = source.indexOf(quote);
  const spans = [
    [0, 700],
    ...(position >= 0
      ? [[Math.max(0, position - 700), Math.min(source.length, position + quote.length + 700)]]
      : []),
    [Math.max(0, source.length - 700), source.length],
  ].sort((a, b) => a[0]! - b[0]!);
  const merged: number[][] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0]! <= previous[1]!) previous[1] = Math.max(previous[1]!, span[1]!);
    else merged.push([...span]);
  }
  return JSON.stringify({
    quote,
    source_context: merged
      .map(([start, end]) => source.slice(start, end))
      .join("\n[Source passage omitted]\n"),
    truncated: true,
    limitation: "Omitted passages may qualify this quote; this excerpt cannot establish absence.",
  });
}

export function jointContextualEvidence(
  atoms: readonly { quote: string; source: string }[],
): string {
  const evidence = atoms.map(({ quote, source }) => contextualEvidence(quote, source));
  return evidence.length === 1
    ? evidence[0]!
    : evidence.map((text, index) => `[${index + 1}] ${text}`).join("\n");
}

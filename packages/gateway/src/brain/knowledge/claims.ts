// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isClaimIdentifier, parseClaimReference, type ClaimReference } from "./references.js";

export interface ClaimParserLimits {
  maxCharacters: number;
  maxClaims: number;
  maxDepth: number;
  maxReferencesPerClaim: number;
}

const DEFAULT_LIMITS: ClaimParserLimits = {
  maxCharacters: 262_144,
  maxClaims: 1_024,
  maxDepth: 16,
  maxReferencesPerClaim: 64,
};

/** Half-open UTF-16 offsets, matching JavaScript string.slice. */
export interface ClaimSpan {
  start: number;
  end: number;
}
export interface ParsedClaim {
  id: string;
  refs: ClaimReference[];
  parentId: string | null;
  sourceSpan: ClaimSpan;
  contentSpan: ClaimSpan;
  textSpan: ClaimSpan;
  /** Readable content including descendants, without structural claim tags. */
  text: string;
  /** Text owned directly by this claim, excluding all child claim content. */
  ownText: string;
}
export interface ParsedClaimMarkup {
  text: string;
  claims: ParsedClaim[];
}

export class ClaimMarkupError extends Error {
  constructor(
    public readonly code: "syntax" | "reference" | "duplicate" | "limit",
    public readonly offset: number,
    message: string,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = "ClaimMarkupError";
  }
}

/**
 * Parse the claim extension, not HTML. Other Markdown is preserved verbatim.
 * Fenced code, inline code, escaped delimiters and HTML comments are examples,
 * not live claims. This validates structure only, never factual coverage.
 */
export function parseClaimMarkup(
  markdown: string,
  options: Partial<ClaimParserLimits> = {},
): ParsedClaimMarkup {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new ClaimMarkupError("limit", 0, "Parser limits must be positive safe integers");
  }
  if (markdown.length > limits.maxCharacters)
    throw new ClaimMarkupError("limit", 0, "Claim document exceeds character limit");
  const claims: ParsedClaim[] = [];
  const stack: ParsedClaim[] = [];
  const ids = new Set<string>();
  const chunks: string[] = [];
  let textLength = 0;
  let offset = 0;
  const append = (value: string): void => {
    chunks.push(value);
    textLength += value.length;
    const owner = stack.at(-1);
    if (owner) owner.ownText += value;
  };
  while (offset < markdown.length) {
    // Block fences have at most three leading spaces. Their entire body is literal.
    if (offset === 0 || markdown[offset - 1] === "\n") {
      const opening = /^( {0,3})(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(markdown.slice(offset));
      if (opening && !(opening[2]![0] === "`" && opening[3]!.includes("`"))) {
        const marker = opening[2]!;
        const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \t]*\r?$`, "gm");
        close.lastIndex = offset + opening[0].length;
        const closing = close.exec(markdown);
        const end = closing ? closing.index + closing[0].length : markdown.length;
        append(markdown.slice(offset, end));
        offset = end;
        continue;
      }
      // Indented code is also literal (including claim examples).
      const indented = /^(?: {4}|\t)[^\n]*(?:\n|$)/.exec(markdown.slice(offset));
      if (indented && stack.length === 0) {
        append(indented[0]);
        offset += indented[0].length;
        continue;
      }
    }
    if (markdown.startsWith("<!--", offset)) {
      const closing = markdown.indexOf("-->", offset + 4);
      const end = closing < 0 ? markdown.length : closing + 3;
      append(markdown.slice(offset, end));
      offset = end;
      continue;
    }
    if (markdown[offset] === "\\" && offset + 1 < markdown.length) {
      append(markdown.slice(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (markdown[offset] === "`") {
      const run = /^`+/.exec(markdown.slice(offset))![0];
      const delimiters = /`+/g;
      delimiters.lastIndex = offset + run.length;
      let next: RegExpExecArray | null;
      let end: number | undefined;
      while ((next = delimiters.exec(markdown))) {
        if (next[0].length === run.length) {
          end = next.index + run.length;
          break;
        }
      }
      if (end !== undefined) {
        append(markdown.slice(offset, end));
        offset = end;
        continue;
      }
      append(run);
      offset += run.length;
      continue;
    }
    if (/^<\/?claim(?=[\s/>:]|$)/i.test(markdown.slice(offset, offset + 10))) {
      const tagEnd = markdown.indexOf(">", offset);
      if (tagEnd < 0) throw new ClaimMarkupError("syntax", offset, "Unterminated claim tag");
      const tag = markdown.slice(offset, tagEnd + 1);
      if (tag === "</claim>") {
        const claim = stack.pop();
        if (!claim) throw new ClaimMarkupError("syntax", offset, "Unexpected closing claim tag");
        claim.sourceSpan.end = tagEnd + 1;
        claim.contentSpan.end = offset;
        claim.textSpan.end = textLength;
      } else {
        if (!/^<claim\s/.test(tag))
          throw new ClaimMarkupError("syntax", offset, "Invalid claim tag");
        const attributes = tag.slice(6, -1);
        const values = new Map<string, string>();
        const attribute = /\s+([a-z]+)="([^"<>]*)"/gy;
        let position = 0;
        while (position < attributes.length) {
          if (/^\s*$/.test(attributes.slice(position))) break;
          attribute.lastIndex = position;
          const match = attribute.exec(attributes);
          if (!match) throw new ClaimMarkupError("syntax", offset, "Invalid claim attributes");
          const name = match[1]!;
          if (name !== "id" && name !== "refs")
            throw new ClaimMarkupError("syntax", offset, "Unknown claim attribute");
          if (values.has(name))
            throw new ClaimMarkupError("duplicate", offset, "Duplicate claim attribute");
          values.set(name, match[2]!);
          position = attribute.lastIndex;
        }
        const id = values.get("id");
        const refsText = values.get("refs");
        if (!id || !isClaimIdentifier(id) || refsText === undefined)
          throw new ClaimMarkupError(
            "syntax",
            offset,
            "Claim requires a safe id and a refs attribute",
          );
        if (ids.has(id)) throw new ClaimMarkupError("duplicate", offset, "Duplicate claim id");
        if (claims.length >= limits.maxClaims || stack.length >= limits.maxDepth)
          throw new ClaimMarkupError("limit", offset, "Claim count or depth limit exceeded");
        const rawRefs = refsText.trim() ? refsText.trim().split(/\s+/) : [];
        if (rawRefs.length > limits.maxReferencesPerClaim)
          throw new ClaimMarkupError("limit", offset, "Claim reference limit exceeded");
        if (new Set(rawRefs).size !== rawRefs.length)
          throw new ClaimMarkupError("duplicate", offset, "Duplicate claim reference");
        let refs: ClaimReference[];
        try {
          refs = rawRefs.map(parseClaimReference);
        } catch {
          throw new ClaimMarkupError("reference", offset, "Invalid claim reference");
        }
        const claim: ParsedClaim = {
          id,
          refs,
          parentId: stack.at(-1)?.id ?? null,
          sourceSpan: { start: offset, end: -1 },
          contentSpan: { start: tagEnd + 1, end: -1 },
          textSpan: { start: textLength, end: -1 },
          text: "",
          ownText: "",
        };
        ids.add(id);
        claims.push(claim);
        stack.push(claim);
      }
      offset = tagEnd + 1;
      continue;
    }
    append(markdown[offset]!);
    offset++;
  }
  if (stack.length)
    throw new ClaimMarkupError("syntax", stack.at(-1)!.sourceSpan.start, "Unclosed claim tag");
  const text = chunks.join("");
  for (const claim of claims) {
    claim.text = text.slice(claim.textSpan.start, claim.textSpan.end);
    if (!claim.text.trim())
      throw new ClaimMarkupError("syntax", claim.sourceSpan.start, "Empty claim");
  }
  return { text, claims };
}

export function stripClaimMarkup(markdown: string, options?: Partial<ClaimParserLimits>): string {
  return parseClaimMarkup(markdown, options).text;
}

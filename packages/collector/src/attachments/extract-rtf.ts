// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:rtf");

const SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "pict",
  "object",
  "objdata",
  "datafield",
  "themedata",
  "generator",
  "info",
  "xmlnstbl",
]);

interface RtfState {
  ucSkip: number;
  skipDestination: boolean;
  ignorableDestination: boolean;
}

export function extractRtfText(
  data: Uint8Array,
  opts?: { maxTextLength?: number },
): ExtractionResult | null {
  if (data.length === 0) return null;

  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    const parsed = parseRtf(Buffer.from(data).toString("latin1"), maxLen);
    const normalized = normalizeText(parsed.text);
    if (!normalized) return null;
    if (!parsed.truncated && normalized.length <= maxLen) {
      log.debug(`RTF extracted: ${normalized.length} chars`);
      return { text: normalized, truncated: false };
    }
    return { text: normalized.slice(0, maxLen), truncated: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`RTF extraction failed (${data.length} bytes): ${msg}`);
    return null;
  }
}

function parseRtf(input: string, maxLen: number): { text: string; truncated: boolean } {
  const stack: RtfState[] = [];
  let state: RtfState = { ucSkip: 1, skipDestination: false, ignorableDestination: false };
  const out: string[] = [];
  const outState = { totalLen: 0, truncated: false };
  let fallbackCharsToSkip = 0;
  const appendText = (value: string) => appendBounded(out, outState, value, maxLen + 1);

  for (let i = 0; i < input.length && !outState.truncated; i++) {
    const char = input[i];

    if (fallbackCharsToSkip > 0) {
      const skipped = skipFallbackChar(input, i);
      i = skipped.nextIndex;
      fallbackCharsToSkip--;
      continue;
    }

    if (char === "{") {
      stack.push({ ...state });
      continue;
    }

    if (char === "}") {
      state = stack.pop() ?? state;
      continue;
    }

    if (char === "\\") {
      const parsed = parseControl(input, i + 1);
      i = parsed.nextIndex;

      if (parsed.kind === "symbol") {
        if (parsed.value === "*") {
          state.ignorableDestination = true;
          continue;
        }
        if (!state.skipDestination) appendSymbol(parsed.value, appendText);
        continue;
      }

      if (parsed.kind === "hex") {
        if (!state.skipDestination) appendText(String.fromCharCode(parsed.value));
        continue;
      }

      const word = parsed.word;
      const param = parsed.param;

      if (word === "uc") {
        state.ucSkip = Math.max(0, param ?? 1);
        continue;
      }
      if (word === "u") {
        if (!state.skipDestination && param !== null)
          appendText(String.fromCodePoint(toRtfCodePoint(param)));
        fallbackCharsToSkip = state.ucSkip;
        continue;
      }
      if (word === "bin") {
        i = Math.min(input.length - 1, i + Math.max(0, param ?? 0));
        continue;
      }

      if (SKIP_DESTINATIONS.has(word) || (state.ignorableDestination && word !== "")) {
        state.skipDestination = true;
        continue;
      }

      if (!state.skipDestination) appendControlWord(word, param, appendText);
      continue;
    }

    if (!state.skipDestination && char !== "\r" && char !== "\n") appendText(char);
  }

  return { text: out.join(""), truncated: outState.truncated };
}

type ParsedControl =
  | { kind: "word"; word: string; param: number | null; nextIndex: number }
  | { kind: "symbol"; value: string; nextIndex: number }
  | { kind: "hex"; value: number; nextIndex: number };

function parseControl(input: string, offset: number): ParsedControl {
  const first = input[offset] ?? "";

  if (first === "'") {
    const hex = input.slice(offset + 1, offset + 3);
    const value = /^[0-9a-fA-F]{2}$/.test(hex) ? Number.parseInt(hex, 16) : 0x20;
    return { kind: "hex", value, nextIndex: offset + 2 };
  }

  if (!/[A-Za-z]/.test(first)) {
    return { kind: "symbol", value: first, nextIndex: offset };
  }

  let cursor = offset;
  while (cursor < input.length && /[A-Za-z]/.test(input[cursor])) cursor++;
  const word = input.slice(offset, cursor);

  let sign = 1;
  if (input[cursor] === "-") {
    sign = -1;
    cursor++;
  }

  const numberStart = cursor;
  while (cursor < input.length && /[0-9]/.test(input[cursor])) cursor++;
  const param =
    cursor > numberStart ? sign * Number.parseInt(input.slice(numberStart, cursor), 10) : null;

  if (input[cursor] === " ") cursor++;
  return { kind: "word", word, param, nextIndex: cursor - 1 };
}

function appendSymbol(symbol: string, appendText: (value: string) => void): void {
  switch (symbol) {
    case "{":
    case "}":
    case "\\":
      appendText(symbol);
      return;
    case "~":
      appendText(" ");
      return;
    case "_":
      appendText("-");
      return;
    case "-":
      return;
    default:
      return;
  }
}

function appendControlWord(
  word: string,
  param: number | null,
  appendText: (value: string) => void,
): void {
  switch (word) {
    case "par":
    case "line":
      appendText("\n");
      return;
    case "tab":
      appendText("\t");
      return;
    case "emdash":
      appendText("--");
      return;
    case "endash":
      appendText("-");
      return;
    case "bullet":
      appendText("* ");
      return;
    case "lquote":
    case "rquote":
      appendText("'");
      return;
    case "ldblquote":
    case "rdblquote":
      appendText('"');
      return;
    case "enspace":
    case "emspace":
    case "qmspace":
      appendText(" ");
      return;
    case "chdate":
    case "chtime":
    case "chpgn":
      if (param !== null) appendText(String(param));
      return;
    default:
      return;
  }
}

function skipFallbackChar(input: string, offset: number): { nextIndex: number } {
  if (input[offset] === "\\" && input[offset + 1] === "'") {
    return { nextIndex: Math.min(input.length - 1, offset + 3) };
  }
  if (input[offset] === "\\") {
    return { nextIndex: parseControl(input, offset + 1).nextIndex };
  }
  return { nextIndex: offset };
}

function toRtfCodePoint(value: number): number {
  const unsigned = value < 0 ? value + 65_536 : value;
  if (!Number.isFinite(unsigned) || unsigned < 0 || unsigned > 0xffff) return 0xfffd;
  return unsigned >= 0xd800 && unsigned <= 0xdfff ? 0xfffd : unsigned;
}

function normalizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendBounded(
  parts: string[],
  state: { totalLen: number; truncated: boolean },
  value: string,
  maxLen: number,
): void {
  if (state.totalLen >= maxLen) {
    state.truncated = true;
    return;
  }

  const remaining = maxLen - state.totalLen;
  if (value.length > remaining) {
    if (remaining > 0) {
      parts.push(value.slice(0, remaining));
      state.totalLen += remaining;
    }
    state.truncated = true;
    return;
  }

  parts.push(value);
  state.totalLen += value.length;
}

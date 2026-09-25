// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one-line account of a command that failed, taken from what it printed:
 * the final block of non-empty lines, at most three of them, joined with
 * spaces, capped at 600 characters, with terminal control sequences removed.
 * A CLI refusal is often several lines whose first names the cause, so the
 * last line alone keeps the advice and loses the reason.
 *
 * `@omnesis/core` carries the same function as `summarizeCommandFailure`, but
 * this package deliberately depends on nothing in the workspace at runtime: it
 * is installed on a harness machine that has no Omnesis checkout. A parity
 * test in the CLI package runs both against the same cases.
 */

import { DEVICE_UPDATE_DETAIL_MAX_CHARS } from "./protocol.js";

const MAX_LINES = 3;
const MAX_CHARS = 600;

// Built from escapes so the source carries no raw control characters.
const ESC = "\\u001b";
const BEL = "\\u0007";
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "gu");
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
const OTHER_ESCAPE = new RegExp(`${ESC}[@-_]`, "gu");
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]", "gu");

export function summarizeCommandFailure(output: string): string {
  const lines = output
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .split(/\r?\n/u)
    // A carriage return redraws the line: only what was drawn last is shown.
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .map((line) => line.replace(CONTROL_CHARACTERS, "").trim());
  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1] && end - start < MAX_LINES) start -= 1;
  let block = lines.slice(start, end);
  // Over the cap, a line gives way from the front — but only a third line, or
  // a first line too long to fit on its own, such as a progress blob printed
  // just before the failure. Two lines that fit apart stay together, and the
  // end is cut instead, because the first line of a refusal names its cause.
  while (
    block.join(" ").length > MAX_CHARS &&
    (block.length > 2 || (block.length === 2 && block[0]!.length > MAX_CHARS))
  ) {
    block = block.slice(1);
  }
  const text = block.join(" ");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1).trimEnd()}…` : text;
}

/**
 * A `device.update.result` detail no longer than the gateway accepts. A detail
 * over the limit is not truncated by the gateway but dropped with its event,
 * so the plugin cuts it here, ending on an ellipsis and never inside a
 * surrogate pair. Restated from `@omnesis/core` like the function above.
 */
export function capDeviceUpdateDetail(detail: string): string {
  if (detail.length <= DEVICE_UPDATE_DETAIL_MAX_CHARS) return detail;
  let cut = detail.slice(0, DEVICE_UPDATE_DETAIL_MAX_CHARS - 1);
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Drift guard between the collector's acknowledgement payloads and the
 * response schemas the gateway validates them against.
 *
 * `CommandHandler` is typed `(command) => Promise<unknown>`, so nothing
 * compiles these replies against the schema — the same hole the phone apps
 * have, and they already have a guard of their own. The collector did not,
 * and it drifted: `source.removed` answered with a document COUNT under
 * `deleted`, a field the schema declares as the list of removed source ids.
 *
 * The consequence was not a broken removal — nothing reads the field — but a
 * successful unmount logged as `source.removed dispatch failed`, which teaches
 * an operator to ignore the one line that reports a collector genuinely
 * failing to unmount a source.
 *
 * Add a case here whenever the collector learns to answer a new command.
 */

import { describe, expect, it } from "vitest";
import { parseResponsePayload, type WsCommandType } from "@omnesis/core";
import { buildSourceRemovedAck } from "./ws-ack-builders.js";

/**
 * Payloads built by the real builders the command switch uses — not
 * transcriptions of them. A copy would stay green through the very drift this
 * file exists to catch.
 */
const COLLECTOR_ACKS: ReadonlyArray<{ label: string; type: WsCommandType; result: unknown }> = [
  {
    label: "source.removed — removed, nothing failed",
    type: "source.removed",
    result: buildSourceRemovedAck({
      sourceId: "gmail:maya.reeves@example.com",
      failures: [],
    }),
  },
  {
    label: "source.removed — a step failed",
    type: "source.removed",
    result: buildSourceRemovedAck({
      sourceId: "gmail:maya.reeves@example.com",
      failures: [{ key: "gmail:maya.reeves@example.com", error: "gateway delete failed: 503" }],
    }),
  },
];

describe("collector acknowledgement payloads satisfy the response schemas", () => {
  for (const { label, type, result } of COLLECTOR_ACKS) {
    it(label, () => {
      const parsed = parseResponsePayload(type, result);
      expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    });
  }
});

describe("the field that drifted", () => {
  it("carries source ids, not a document count", () => {
    // The collector used to put `removeSources`' deleted-document COUNT here.
    // The gateway rejected the reply and logged a successful unmount as
    // "source.removed dispatch failed" — training an operator to ignore the
    // one line that reports a collector genuinely failing to unmount.
    const ack = buildSourceRemovedAck({
      sourceId: "gmail:maya.reeves@example.com",
      failures: [],
    });
    expect(ack.deleted).toEqual(["gmail:maya.reeves@example.com"]);
  });

  it("and a count in that field is rejected by the schema", () => {
    const parsed = parseResponsePayload("source.removed", {
      ok: true,
      applied: true,
      deleted: 145971,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/deleted/);
  });

  it("reports ok: false when a removal step failed", () => {
    const ack = buildSourceRemovedAck({
      sourceId: "gmail:maya.reeves@example.com",
      failures: [{ key: "gmail:maya.reeves@example.com", error: "503" }],
    });
    expect(ack.ok).toBe(false);
  });
});

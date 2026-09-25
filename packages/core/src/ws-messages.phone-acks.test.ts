// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Drift guard between the phone apps' hardcoded acknowledgement payloads and
 * the response schemas they are validated against.
 *
 * The apps are Swift and Kotlin, so nothing compiles them against these
 * schemas. When they disagree the gateway rejects the reply as a malformed
 * payload and `/admin/sources/:id/sync` reports 502 for a sync that ran —
 * which is exactly the failure this fixture exists to catch. Each literal
 * below is transcribed from the corresponding `run(_:)` / `commandReply()`
 * branch; changing one without changing the app is the regression.
 *
 * Add a case here whenever a phone app learns to answer a new command.
 */
import { describe, it, expect } from "vitest";
import { parseResponsePayload, type WsCommandType } from "./ws-messages.js";

/** Payloads produced by `DeviceSocket.run(_:)` (iOS) and `commandReply()` (Android). */
const PHONE_ACKS: ReadonlyArray<{ label: string; type: WsCommandType; result: unknown }> = [
  {
    label: "source.sync — a sync started",
    type: "source.sync",
    result: { ok: true, triggered: 1, skipped: 0 },
  },
  {
    label: "source.sync — hosted but nothing started (iOS)",
    type: "source.sync",
    result: { ok: true, triggered: 0, skipped: 1, error: "the collector is still starting up" },
  },
  {
    label: "source.added / source.updated / sources.snapshot",
    type: "source.added",
    result: { ok: true, applied: false },
  },
  {
    label: "sources.snapshot shares source.added's shape",
    type: "sources.snapshot",
    result: { ok: true, applied: false },
  },
  {
    label: "source.updated",
    type: "source.updated",
    result: { ok: true, applied: false },
  },
  {
    label: "source.removed",
    type: "source.removed",
    result: { ok: true, applied: false, deleted: [] },
  },
  {
    label: "source.debug",
    type: "source.debug",
    result: { status: { sourceId: "apple-health:local", note: "hosted here" } },
  },
];

describe("phone acknowledgement payloads validate against their response schemas", () => {
  it.each(PHONE_ACKS)("$label", ({ type, result }) => {
    const parsed = parseResponsePayload(type, result);
    expect(parsed.ok, parsed.ok ? "" : `rejected: ${parsed.error}`).toBe(true);
  });

  it("rejects the empty object the apps used to send for source.sync", () => {
    // The original bug: `sourceSyncResponse` requires `ok`, so `{}` is refused.
    // If this ever starts passing, the schema stopped carrying the field the
    // gateway relies on to tell success from failure.
    const parsed = parseResponsePayload("source.sync", {});
    expect(parsed.ok).toBe(false);
  });
});

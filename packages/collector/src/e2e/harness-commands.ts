// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseRequestPayload } from "@omnesis/core";
import type { SyncEngine } from "../sync-engine.js";

/** The synthetic collector owns the real sync engine, without importing daemon startup side effects. */
export function handleHarnessCommand(
  engine: Pick<SyncEngine, "triggerSync">,
  command: { type: string; payload: unknown },
): unknown {
  if (command.type === "sources.snapshot") return { ok: true, applied: true };
  if (command.type === "source.sync") {
    const parsed = parseRequestPayload("source.sync", command.payload);
    if (!parsed.ok) throw new Error("Invalid synthetic source sync payload");
    const result = engine.triggerSync(parsed.value.sourceId, {
      restart: parsed.value.restart === true,
    });
    return {
      ok: !result.error,
      triggered: result.triggered.length,
      skipped: result.skipped.length,
      disabled: result.disabled.length,
      restarting: result.restarting.length,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  throw new Error(`Unsupported synthetic harness command: ${command.type}`);
}

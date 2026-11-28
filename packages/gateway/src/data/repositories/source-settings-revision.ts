// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import type { DeviceId } from "@omnesis/types";
import type { SourceRecord } from "./SourceRepository.js";

/** A settings precondition binds both ownership and config, including same-millisecond edits. */
export function sourceSettingsRevision(
  source: SourceRecord,
  member?: { deviceId: DeviceId; config: Record<string, unknown> | null },
): string {
  return createHash("sha256")
    .update(JSON.stringify({ source, ...(member ? { member } : {}) }))
    .digest("hex");
}

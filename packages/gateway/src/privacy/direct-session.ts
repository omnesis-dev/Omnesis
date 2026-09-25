// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Grouping keys for Direct MCP audit sessions. An external agent may pass
 * the same optional `conversationId`/`workflowId` grouping keys that
 * `ask_omnesis` accepts; when it does, the transcript session is exact.
 * Otherwise the writer falls back to a heuristic session per
 * principal+credential, split after an idle gap. This module is pure
 * key-derivation (no database, no clock); the idle-gap split is applied
 * at lookup time against the stored `last_event_at`.
 */

import { DIRECT_GROUPING_KEY_PATTERN } from "../agent/direct-mcp.js";

export const DIRECT_HEURISTIC_SESSION_GAP_MS = 60 * 60 * 1_000;

export interface DirectSessionRequest {
  principalId: string;
  credentialId: string;
  conversationId?: string;
  workflowId?: string;
}

export interface DirectSessionKeys {
  /** `conversation:<id>` or `workflow:<id>` when the caller supplied a valid key. */
  explicitKey: string | null;
  /**
   * `<principalId>|<credentialId>` fallback identity. The idle-gap split is
   * applied at lookup time against the session's `last_event_at`, so the key
   * itself carries no time bucket — a session stays whole across an hour
   * boundary while the caller keeps talking.
   */
  heuristicKey: string;
}

function validGroupingKey(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && DIRECT_GROUPING_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

export function directSessionKeys(request: DirectSessionRequest): DirectSessionKeys {
  const conversationId = validGroupingKey(request.conversationId);
  const workflowId = validGroupingKey(request.workflowId);
  const explicitKey =
    conversationId !== null
      ? `conversation:${conversationId}`
      : workflowId !== null
        ? `workflow:${workflowId}`
        : null;
  return {
    explicitKey,
    heuristicKey: `${request.principalId}|${request.credentialId}`,
  };
}

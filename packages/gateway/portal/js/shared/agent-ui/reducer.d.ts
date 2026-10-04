// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AgentUiPart } from "./index.js";
export interface AgentUiState {
  turns: { id: string; role: string; parts: AgentUiPart[]; done?: boolean }[];
  busy: boolean;
  [key: string]: unknown;
}
export function initialState(): AgentUiState;
export function reducer(
  state: AgentUiState,
  action: { kind: string; payload?: Record<string, unknown>; toolCallId?: string },
): AgentUiState;

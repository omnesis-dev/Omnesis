// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const ACTIVE_REFRESH_MS: number;
export const IDLE_REFRESH_MS: number;

export interface SourcesPollInput {
  sources: ReadonlyArray<{
    removing?: boolean;
    syncStatus?: { state?: string | null } | null;
  }>;
  indexStats: {
    state?: string;
    totalGatewayDocs?: number;
    totalIndexed?: number;
    totalIndexErrors?: number;
    indexVersions?: { building?: unknown } | null;
    lexicalIndex?: { building?: unknown } | null;
  } | null;
  busy: Record<string, unknown>;
}

export function sourcesRefreshIntervalMs(input: SourcesPollInput): number;

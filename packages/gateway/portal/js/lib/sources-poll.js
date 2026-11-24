// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const ACTIVE_REFRESH_MS = 2000;
export const IDLE_REFRESH_MS = 15_000;

export function sourcesRefreshIntervalMs({ sources, indexStats, busy }) {
  const sourceActive =
    Object.keys(busy).length > 0 ||
    sources.some((s) => s.removing || s.syncStatus?.state === "syncing");
  const indexActive =
    indexStats?.state === "spawning" ||
    indexStats?.indexVersions?.building != null ||
    indexStats?.lexicalIndex?.building != null ||
    (indexStats?.totalGatewayDocs ?? 0) >
      (indexStats?.totalIndexed ?? 0) + (indexStats?.totalIndexErrors ?? 0);
  return sourceActive || indexActive ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
}

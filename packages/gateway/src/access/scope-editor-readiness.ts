// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { devicesCapabilitiesCodec } from "../data/json-columns.js";
import { getSourceScopes } from "./scope-descriptors.js";
import type { SourceScopeKindReadiness } from "@omnesis/types";
import type { Db } from "../data/types.js";

/** Bounded source/device metadata only; document counts belong on the read worker. */
export function sourceScopeReadiness(db: Db, sourceId: string): SourceScopeKindReadiness[] {
  const source = db
    .prepare<[string], { type: string }>("SELECT type FROM sources WHERE id=?")
    .get(sourceId);
  const scopes = source && getSourceScopes(db, source.type);
  if (!scopes) return [];
  const state = db
    .prepare<[string], { ready: number; processed: number }>(
      "SELECT ready,processed FROM scope_fact_backfill WHERE source_id=?",
    )
    .get(sourceId);
  const hosts = db
    .prepare<[string, string], { id: string; name: string; capabilities: string }>(
      `SELECT d.id,d.name,d.capabilities FROM devices d
    WHERE d.revoked_at IS NULL AND d.kind='collector' AND (d.id IN (SELECT device_id FROM sources WHERE id=?)
      OR d.id IN (SELECT device_id FROM source_devices WHERE source_id=?)) ORDER BY d.id`,
    )
    .all(sourceId, sourceId);
  const unsupportedHosts = (minimum: number) =>
    hosts
      .filter((host) => {
        const range = devicesCapabilitiesCodec.parseWithFallback(host.capabilities, {
          rowId: host.id,
        }).sourceScopes;
        if (!range || typeof range !== "object") return true;
        const capability = range as { min?: unknown; max?: unknown };
        return (
          typeof capability.min !== "number" ||
          !Number.isSafeInteger(capability.min) ||
          capability.min < 1 ||
          typeof capability.max !== "number" ||
          !Number.isSafeInteger(capability.max) ||
          capability.min > minimum ||
          capability.max < minimum
        );
      })
      .map(({ id, name }) => ({ deviceId: id, name }));
  return scopes.items.map((item) => {
    const requiresEpoch = !!db
      .prepare("SELECT 1 FROM source_scope_refresh_requirements WHERE source_id=? AND kind=?")
      .get(sourceId, item.kind);
    const behindCollectors = unsupportedHosts(item.kind === "folder" || requiresEpoch ? 2 : 1);
    const editor = db
      .prepare<[string, string], { ready: number }>(
        "SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind=?",
      )
      .get(sourceId, item.kind);
    const refreshing = !!db
      .prepare("SELECT 1 FROM source_scope_refreshes WHERE source_id=? AND kind=? AND active=1")
      .get(sourceId, item.kind);
    const native = item.kind === "label" || item.kind === "folder";
    const ready = state?.ready === 1 && !refreshing && (!native || editor?.ready === 1);
    const reason = ready
      ? undefined
      : state?.ready !== 1
        ? "backfill"
        : (native || refreshing) && behindCollectors.length
          ? "collector-upgrade"
          : "metadata-refresh";
    const message =
      reason === "backfill"
        ? "Preparing stored documents for filters."
        : reason === "collector-upgrade"
          ? "Update the source's collectors to prepare filter metadata."
          : reason === "metadata-refresh"
            ? "Refreshing source filter metadata."
            : undefined;
    return {
      kind: item.kind,
      ready,
      ...(reason ? { reason, message } : {}),
      processed: state?.processed ?? 0,
      ...(behindCollectors.length ? { behindCollectors } : {}),
    };
  });
}

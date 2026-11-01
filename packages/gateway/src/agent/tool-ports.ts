// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalVisible } from "@omnesis/core";
import { createGatewayLoopReadPort } from "../brain/interactive-loop-port.js";
import { createGatewayTemporalPort } from "../enrichment/temporal/interactive-temporal-port.js";
import { createGatewayEntityContextPort } from "../domain/cognitive-graph/interactive-entity-context-port.js";
import {
  createGatewayDocumentByUrlPort,
  createGatewayDocumentPort,
  createGatewayPersonPort,
  createGatewayRecordPort,
  createGatewaySearchPort,
  createGatewaySqlPort,
  createGatewayTrailPort,
} from "./ports.js";
import { createGatewayWatchPort } from "./watch-port.js";
import { createGatewayMessageCountPort } from "./message-count-port.js";
import type { ToolPorts } from "@omnesis/agent";
import type { AgentServiceDeps } from "./agent-lifecycle.js";

export type GatewayAgentPortsDeps = Pick<
  AgentServiceDeps,
  | "db"
  | "searchPipeline"
  | "syncStatus"
  | "analyticsDb"
  | "personLookupGate"
  | "messageCountGate"
  | "getWatchAuthoring"
  | "watchFirings"
  | "watchFiringCount"
  | "isApnsConfigured"
  | "watchPreflight"
  | "mentionWorthGateActive"
>;

/** Gateway tools share the same data access and gates across agent model roles. */
export function createGatewayAgentPorts(deps: GatewayAgentPortsDeps): ToolPorts {
  const { db, searchPipeline, syncStatus, analyticsDb } = deps;
  return {
    // `db` is passed so the agent search port can attach the 1-hop
    // breadcrumb to top hits when graph context is off.
    search: createGatewaySearchPort(searchPipeline, syncStatus, db),
    document: createGatewayDocumentPort(db, syncStatus, {
      graphContext: searchPipeline.agentSearchV2Enabled,
    }),
    documentByUrl: createGatewayDocumentByUrlPort(db, syncStatus),
    // `trace_connections` surfaces `same-entity` bound rows as point-in-time
    // records, so it needs the same analytics DB `cite_record` uses
    // (for the bound-row resolver + the record-display contract).
    trail: createGatewayTrailPort(db, analyticsDb, {
      graphContext: searchPipeline.agentSearchV2Enabled,
    }),
    sql: createGatewaySqlPort(analyticsDb),
    // `cite_record` persists a single analytics row as a record citation.
    // Wired with the same analytics DB as `run_sql` (for the table
    // contract) and the document store (to resolve a bound document id).
    record: createGatewayRecordPort(db, analyticsDb),
    person: createGatewayPersonPort(db, { lookupGate: deps.personLookupGate }),
    // Unscoped, like `temporal`; source-restricted answers build separate ports.
    messageCounts: createGatewayMessageCountPort(db, {
      ...(deps.messageCountGate ? { gate: deps.messageCountGate } : {}),
    }),
    watch: experimentalVisible()
      ? createGatewayWatchPort({
          getAuthoring: deps.getWatchAuthoring,
          firings: deps.watchFirings,
          firingCount: deps.watchFiringCount,
          isApnsConfigured: () => deps.isApnsConfigured(),
          ...(deps.watchPreflight ? { preflight: deps.watchPreflight } : {}),
        })
      : undefined,
    // Read-only loop port (experimental): lets the interactive agent find and
    // read the background Cognition Steward's tracked obligations — no mutation, no
    // briefs. The registry also gates these tools on experimental mode.
    loopRead: experimentalVisible() ? createGatewayLoopReadPort(db) : undefined,
    // Read-only temporal port: lets the interactive agent answer "what's
    // coming up?" in one call — source-owned dated facts and date mentions,
    // both produced on the ingest path whether or not the background agent
    // runs, plus that agent's own selective interpretations when it does.
    // Source-restricted answers build separate ports and do not receive this.
    // No write surface.
    temporal: createGatewayTemporalPort(db, analyticsDb, undefined, {
      ...(deps.mentionWorthGateActive ? { hideUnworthyMentions: deps.mentionWorthGateActive } : {}),
    }),
    // Read-only cognitive-context (reap) port (experimental): lets the
    // interactive agent pull the whole neighbourhood the background agent
    // linked around one entity in a single call — no write surface.
    entityContext: experimentalVisible() ? createGatewayEntityContextPort(db) : undefined,
  };
}

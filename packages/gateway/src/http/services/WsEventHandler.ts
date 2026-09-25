// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  isAuthErrorCode,
  isKnownEventType,
  parseEventPayload,
  parseRequestPayload,
} from "@omnesis/core";
import {
  SCOPE_ADMIN,
  SCOPE_WRITE_ALL,
  scopeSatisfies,
  trySourceId,
  writeScope,
  type SourceId,
} from "@omnesis/types";
import {
  getSource,
  isSourceMember,
  listSourcesForMember,
  listSourceMembers,
} from "../../data/repositories/SourceRepository.js";
import { getDevice } from "../../data/repositories/DeviceRepository.js";
import { deviceSupportsExistingSourceExecution } from "../../data/repositories/SourceMemberConfigContractRepository.js";
import { cursorDeviceFor } from "../../multi-device-mode.js";
import { AgentError, type AgentService } from "../../agent/service.js";
import type { WireChallenge } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";
import type { WsCommand, WsEvent } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type { SyncStatusRegistry } from "../../sync-status.js";
import type { AuthFlowRegistry, AuthFlowEventType } from "../../auth-flows.js";
import type { ImportFlowRegistry } from "../../import-flows.js";
import type { DeviceConnection, DeviceWsServer } from "../../ws.js";
import type { FleetUpdateService } from "./FleetUpdateService.js";
import type { DeviceDoctorService } from "./DeviceDoctorService.js";
import type { NeedsAuthNotifier } from "../../push/producers/needs-auth.js";

type Db = Database.Database;

const log = createLogger("gateway").child("ws-events");

export interface WsEventHandlerDeps {
  db: Db;
  writeGate: WriteGate;
  syncStatus: SyncStatusRegistry;
  authFlows: AuthFlowRegistry;
  /** Optional — when omitted, import.* events are dropped. */
  importFlows?: ImportFlowRegistry;
  /** Optional — when omitted, agent.* commands return unsupported. */
  agentService?: AgentService;
  /**
   * Optional — when omitted, a source entering `needs-auth` does not push
   * a re-auth reminder (#617). Wired only when iOS push is in play.
   */
  needsAuthNotifier?: NeedsAuthNotifier;
  /**
   * Optional — when omitted, a commanded self-update is neither dispatched
   * on reconnect nor recorded when the device reports back.
   */
  fleetUpdate?: FleetUpdateService;
  /** Durable collector-local health checks and their correlated results. */
  deviceDoctor?: DeviceDoctorService;
}

/**
 * Extracted from index.ts: per-connection handlers passed to DeviceWsServer.
 * The wsServer reference is supplied after construction via attachServer()
 * because the server is built with these handlers as inputs.
 */
export class WsEventHandler {
  private readonly db: Db;
  private readonly writeGate: WriteGate;
  private readonly syncStatus: SyncStatusRegistry;
  private readonly authFlows: AuthFlowRegistry;
  private readonly importFlows: ImportFlowRegistry | undefined;
  private agentService: AgentService | undefined;
  private readonly needsAuthNotifier: NeedsAuthNotifier | undefined;
  private readonly fleetUpdate: FleetUpdateService | undefined;
  private readonly deviceDoctor: DeviceDoctorService | undefined;
  private wsServer: DeviceWsServer | null = null;

  constructor(deps: WsEventHandlerDeps) {
    this.db = deps.db;
    this.writeGate = deps.writeGate;
    this.syncStatus = deps.syncStatus;
    this.authFlows = deps.authFlows;
    this.importFlows = deps.importFlows;
    this.agentService = deps.agentService;
    this.needsAuthNotifier = deps.needsAuthNotifier;
    this.fleetUpdate = deps.fleetUpdate;
    this.deviceDoctor = deps.deviceDoctor;
  }

  /** Attach (or clear) the agent service. Called at boot and on hot-swap. */
  attachAgentService(service: AgentService | undefined): void {
    this.agentService = service;
  }

  /** Wire the DeviceWsServer that will be used for broadcasts + outbound commands. */
  attachServer(server: DeviceWsServer): void {
    this.wsServer = server;
  }

  handleEvent = (conn: DeviceConnection, event: WsEvent): void => {
    if (!isKnownEventType(event.type)) {
      // Drop silently — unknown event types (e.g. `sources.discover` future
      // affordance) are noise for handlers but harmless. The previous code
      // had a no-op branch for `sources.discover`; that's now implicit.
      return;
    }
    if (event.type === "sync.status") {
      const parsed = parseEventPayload("sync.status", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed sync.status: ${parsed.error}`);
        return;
      }
      const payload = parsed.value;
      const sourceId = trySourceId(payload.sourceId);
      if (!sourceId) {
        log.debug("Dropping malformed sync.status: invalid sourceId");
        return;
      }
      if (!this.canIngestSyncStatus(conn, sourceId)) return;
      // A completed report with an explicit empty list proves recovery.
      // Legacy omission, progress, and failed attempts prove no such thing.
      if (payload.state === "completed" && payload.issues !== undefined) {
        void this.writeGate
          .replaceSourceSyncIssues(
            sourceId,
            conn.deviceId,
            payload.issues,
            payload.issueAssessments,
          )
          .catch((error) => {
            log.warn(
              `Failed to persist sync diagnostics: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      // Capture the reporting device's OWN prior state BEFORE the update:
      // the registry merges updates in place, so reading after update()
      // would lose the previous value, and the per-source aggregate would
      // let a sibling member's report stand in for this device's. An
      // absent prior entry reads as a non-`completed` state, so a member's
      // very first report being `completed` counts as an edge into it.
      const priorState = this.syncStatus
        .listMembers(sourceId)
        .find((entry) => entry.deviceId === conn.deviceId)?.state;
      this.syncStatus.update({
        sourceId,
        deviceId: conn.deviceId,
        providerId: payload.providerId,
        state: payload.state,
        unitName: payload.unitName,
        progress: payload.progress,
        coverage: payload.coverage,
        coverageDetail: payload.coverageDetail,
        startedAt: payload.startedAt,
        completedAt: payload.completedAt,
        errorMessage: payload.errorMessage,
        remediation: payload.remediation,
        freshness: payload.freshness,
        lastUpdated: Date.now(),
      });
      // Credentials are held per device, so a lapse is a fact about
      // (connection, reporting device): a sibling member's healthy grant
      // neither satisfies nor clears it. Re-auth reminders are due while
      // this device keeps reporting `needs-auth`; the notifier's persisted,
      // per-(connection, device) gate is the authoritative de-dup +
      // exponential backoff (#683), so repeated ticks can advance the
      // reminder ladder without sending once per source per tick.
      if (payload.state === "needs-auth") {
        void this.needsAuthNotifier?.notify({
          sourceId: payload.sourceId,
          providerId: payload.providerId,
          deviceId: conn.deviceId,
        });
      }
      // A successful sync means this device's credentials are healthy
      // again — reset its reminder backoff so a future expiry starts the
      // ladder from the immediate first push (#683). Fire on the edge into
      // `completed` (not every steady-state tick): the real re-auth path is
      // needs-auth → syncing → completed, so we can't gate on the prior
      // state being needs-auth. The notifier short-circuits entirely when
      // APNs is unconfigured, so a reminderless install does no work here.
      if (payload.state === "completed" && priorState !== "completed") {
        void this.needsAuthNotifier?.reset({
          sourceId: payload.sourceId,
          providerId: payload.providerId,
          deviceId: conn.deviceId,
        });
      }
      // Persist (or clear) error state so it survives gateway restart.
      // Successful cursor saves clear errors via setSyncState — but the
      // collector might emit `sync.status` with state="completed" without
      // having just saved a cursor (e.g. no-op cycle), so handle both.
      if (
        (payload.state === "error" ||
          payload.state === "needs-auth" ||
          payload.state === "rate-limited") &&
        payload.errorMessage
      ) {
        // Persist the message so it survives gateway restart. The
        // needs-auth / rate-limited cases carry a recognisable prefix
        // (`needs reauth: ` / `rate-limited: `) that `deriveDisplayStatus`
        // maps back to the right pill when in-memory state is empty. A
        // structured remedy is persisted beside the message it explains.
        const row = this.statusRowFor(payload.sourceId, conn);
        void this.writeGate
          .setSyncError(payload.sourceId, payload.errorMessage, row, payload.remediation)
          .catch((err) => {
            log.warn(
              `failed to persist sync error for ${payload.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      } else if (payload.state === "completed") {
        const row = this.statusRowFor(payload.sourceId, conn);
        void (
          row
            ? this.writeGate.clearSyncError(payload.sourceId, row)
            : this.writeGate.clearSyncError(payload.sourceId)
        ).catch((err) => {
          log.warn(
            `failed to clear sync error for ${payload.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      // Re-broadcast to admin subscribers (CLI/portal).
      this.wsServer?.broadcast(event);
    } else if (event.type === "auth.update") {
      const parsed = parseEventPayload("auth.update", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed auth.update: ${parsed.error}`);
        return;
      }
      const payload = parsed.value;
      if (!this.canIngestAuthEvent(conn, payload.flowId, "auth.update")) return;
      const eventType = (payload.type as AuthFlowEventType | undefined) ?? "info";
      // `auth.update` is passthrough-typed, so a `widget` event carries
      // `kind` + `payload` alongside the declared fields. Thread them so the
      // SSE subscriber can hand the client the hosted-widget config.
      const widgetKind = typeof payload.kind === "string" ? payload.kind : undefined;
      const widgetPayload =
        payload.payload && typeof payload.payload === "object"
          ? (payload.payload as Record<string, string>)
          : undefined;
      // A typed challenge arrives whole, under the id an answer will name.
      // It is not inspected here: the point of carrying its kind and its words
      // on itself is that nothing between the source and the operator needs to
      // know what platform it came from.
      const challenge =
        payload.challenge && typeof payload.challenge === "object"
          ? (payload.challenge as WireChallenge)
          : undefined;
      this.authFlows.ingestEvent(payload.flowId, {
        type: eventType,
        url: payload.url,
        data: payload.data,
        kind: widgetKind,
        payload: widgetPayload,
        message: payload.message,
        challenge,
        id: typeof payload.id === "string" ? payload.id : undefined,
        // Whether an answer is wanted. A field named here and nowhere else is
        // the failure this handler is shaped for: the event arrives
        // passthrough-typed with everything on it, and is rebuilt from a fixed
        // list, so a field the list forgets is dropped in the middle of a path
        // whose every other hop carries it. Anything added to the challenge
        // event has to be added here too.
        expectsAnswer:
          typeof payload.expectsAnswer === "boolean" ? payload.expectsAnswer : undefined,
      });
      this.wsServer?.broadcast(event);
    } else if (event.type === "auth.complete") {
      const parsed = parseEventPayload("auth.complete", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed auth.complete: ${parsed.error}`);
        return;
      }
      const payload = parsed.value;
      if (!this.canIngestAuthEvent(conn, payload.flowId, "auth.complete")) return;
      this.authFlows.ingestEvent(payload.flowId, {
        type: "complete",
        ok: payload.ok,
        accountId: payload.accountId,
        accountIds: payload.accountIds,
        accountStates: payload.accountStates,
        notices: payload.notices,
        error: payload.error,
        code: isAuthErrorCode(payload.code) ? payload.code : undefined,
        fileKey: payload.fileKey,
        providerName: payload.providerName,
        remedy: payload.remedy,
        retryAfterMs: payload.retryAfterMs,
      });
      this.wsServer?.broadcast(event);
    } else if (event.type === "import.progress") {
      const parsed = parseEventPayload("import.progress", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed import.progress: ${parsed.error}`);
        return;
      }
      const payload = parsed.value;
      if (!this.canIngestImportEvent(conn, payload.flowId, "import.progress")) return;
      this.importFlows?.ingestEvent(payload.flowId, {
        type: "progress",
        phase: payload.phase,
        processed: payload.processed,
        total: payload.total,
        detail: payload.detail,
      });
    } else if (event.type === "import.complete") {
      const parsed = parseEventPayload("import.complete", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed import.complete: ${parsed.error}`);
        return;
      }
      const payload = parsed.value;
      if (!this.canIngestImportEvent(conn, payload.flowId, "import.complete")) return;
      this.importFlows?.ingestEvent(payload.flowId, {
        type: "complete",
        ok: payload.ok,
        imported: payload.imported,
        merged: payload.merged,
        skipped: payload.skipped,
        error: payload.error,
      });
    } else if (event.type === "device.update.result") {
      const parsed = parseEventPayload("device.update.result", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed device.update.result: ${parsed.error}`);
        return;
      }
      // The device reports only on itself — the connection is the
      // authorization, and there is nothing in the payload to widen it to
      // another row.
      void this.fleetUpdate?.recordResult(conn.deviceId, parsed.value).catch((err) => {
        log.warn(
          `Could not record an update result: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else if (event.type === "device.doctor.result") {
      if (!scopeSatisfies(conn.scopes, SCOPE_WRITE_ALL)) {
        log.debug(`Dropping device.doctor.result from a connection without collector scope`);
        return;
      }
      const parsed = parseEventPayload("device.doctor.result", event.payload);
      if (!parsed.ok) {
        log.debug(`Dropping malformed device.doctor.result: ${parsed.error}`);
        return;
      }
      void this.deviceDoctor?.recordResult(conn.deviceId, parsed.value).catch((err) => {
        log.warn(
          `Could not record a device doctor result: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };

  /**
   * The `sync_state` row a member's status lands on: its own for
   * per-device-cursor modes, the shared one (`""`) otherwise — in which case
   * the error write keeps its single-row shape.
   */
  private statusRowFor(sourceId: string, conn: DeviceConnection): string {
    const parsed = trySourceId(sourceId);
    const source = parsed ? getSource(this.db, parsed) : null;
    return source ? cursorDeviceFor(source.multiDeviceMode, conn.deviceId) : "";
  }

  private canIngestSyncStatus(conn: DeviceConnection, sourceId: SourceId): boolean {
    const source = getSource(this.db, sourceId);
    if (!source) {
      log.warn("Dropping unauthorized sync.status: source is not registered");
      return false;
    }
    // Any member may report; the owning device is always a member, and
    // multi-member modes report through the same gate.
    if (source.deviceId !== conn.deviceId && !isSourceMember(this.db, sourceId, conn.deviceId)) {
      log.warn("Dropping unauthorized sync.status: device is not a member of this source");
      return false;
    }
    if (!scopeSatisfies(conn.scopes, writeScope(source.type))) {
      log.warn("Dropping unauthorized sync.status: source write scope required");
      return false;
    }
    return true;
  }

  private canIngestAuthEvent(
    conn: DeviceConnection,
    flowId: string,
    eventType: "auth.update" | "auth.complete",
  ): boolean {
    const flow = this.authFlows.get(flowId);
    if (!flow) {
      log.warn(`Dropping unauthorized ${eventType}: flow not found`);
      return false;
    }
    if (flow.deviceId !== conn.deviceId) {
      log.warn(`Dropping unauthorized ${eventType}: flow is owned by another device`);
      return false;
    }
    if (flow.state === "completed" || flow.state === "error") return false;
    return true;
  }

  private canIngestImportEvent(
    conn: DeviceConnection,
    flowId: string,
    eventType: "import.progress" | "import.complete",
  ): boolean {
    if (!this.importFlows) return false;
    const flow = this.importFlows.get(flowId);
    if (!flow) {
      log.warn(`Dropping unauthorized ${eventType}: flow not found`);
      return false;
    }
    if (flow.deviceId !== conn.deviceId) {
      log.warn(`Dropping unauthorized ${eventType}: flow is owned by another device`);
      return false;
    }
    return true;
  }

  handleCommand = async (conn: DeviceConnection, command: WsCommand): Promise<unknown> => {
    if (
      command.type === "agent.session.create" ||
      command.type === "agent.message.send" ||
      command.type === "agent.session.cancel"
    ) {
      return this.handleAgentCommand(conn, command);
    }
    // Devices currently don't issue other commands TO the gateway beyond
    // the hello handshake (which is consumed inside ws.ts before this
    // hook runs). New device-originated commands should be added
    // explicitly to the registry and dispatched here.
    throw new Error(`unsupported command: ${command.type}`);
  };

  private async handleAgentCommand(conn: DeviceConnection, command: WsCommand): Promise<unknown> {
    if (!scopeSatisfies(conn.scopes, SCOPE_ADMIN)) {
      throw new Error("forbidden: agent commands require admin scope");
    }
    if (!this.agentService) {
      throw new Error("agent harness not enabled on this gateway");
    }
    try {
      const callerId = `device:${conn.deviceId}`;
      if (command.type === "agent.session.create") {
        const parsed = parseRequestPayload("agent.session.create", command.payload);
        if (!parsed.ok) throw new Error(`invalid payload: ${parsed.error}`);
        // The operator's own device. This transport is admin-scoped and an
        // agent integration is never granted admin scope when it pairs, so
        // nothing else can open a session here — and a session opened with no
        // audience at all falls to the narrowest one, which would hide every
        // watch on the install from the operator's own phone.
        return await this.agentService.createSession(callerId, {
          caller: { kind: "operator" },
        });
      }
      if (command.type === "agent.message.send") {
        const parsed = parseRequestPayload("agent.message.send", command.payload);
        if (!parsed.ok) throw new Error(`invalid payload: ${parsed.error}`);
        return this.agentService.sendMessage(callerId, parsed.value.sessionId, parsed.value.text);
      }
      if (command.type === "agent.session.cancel") {
        const parsed = parseRequestPayload("agent.session.cancel", command.payload);
        if (!parsed.ok) throw new Error(`invalid payload: ${parsed.error}`);
        return this.agentService.cancelSession(callerId, parsed.value.sessionId);
      }
    } catch (err) {
      if (err instanceof AgentError) throw err;
      throw err instanceof Error ? err : new Error(String(err));
    }
    throw new Error(`unreachable for agent command: ${command.type}`);
  }

  handleConnected = (conn: DeviceConnection): void => {
    // Runs for every kind: an agent-harness plugin holds a device socket too,
    // and a self-update parked while it was offline is owed to it just the
    // same. Independent of the collector snapshot below, so a device with no
    // sources still gets the update it is waiting for.
    void this.fleetUpdate?.onDeviceConnected(conn.deviceId).catch((err) => {
      log.warn(
        `Could not settle a pending update: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (scopeSatisfies(conn.scopes, SCOPE_WRITE_ALL)) {
      void this.deviceDoctor?.onDeviceConnected(conn.deviceId).catch((err) => {
        log.warn(
          `Could not resume a pending device doctor run: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // Only collectors host pull sources and reconcile against this snapshot;
    // phones and the browser extension push their own and would just be
    // receiving a command they have no use for.
    const device = getDevice(this.db, conn.deviceId);
    if (device?.kind !== "collector") return;
    // Sent even when the list is empty. The snapshot is the gateway's
    // authoritative statement of what this device should host, and "nothing" is
    // a legitimate statement: a collector whose last source was removed, or
    // reassigned to another host, while it was offline learns it here and tears
    // the instance down.
    const sources = listSourcesForMember(this.db, conn.deviceId).filter((source) =>
      deviceSupportsExistingSourceExecution(this.db, source, device),
    );
    void this.wsServer?.sendCommand(conn.deviceId, "sources.snapshot", { sources }).catch(() => {
      // Device may not handle the command; that's fine.
    });
    // A unanimous repin can move shared values into member overlays. Refresh
    // connected siblings so every host receives its current effective config.
    const refreshed = new Set([conn.deviceId]);
    for (const sourceId of conn.memberConfigChangedSourceIds ?? []) {
      for (const member of listSourceMembers(this.db, sourceId)) {
        if (refreshed.has(member.deviceId) || !this.wsServer?.isConnected(member.deviceId))
          continue;
        refreshed.add(member.deviceId);
        const sibling = getDevice(this.db, member.deviceId);
        if (sibling?.kind !== "collector") continue;
        const memberSources = listSourcesForMember(this.db, member.deviceId).filter((source) =>
          deviceSupportsExistingSourceExecution(this.db, source, sibling),
        );
        void this.wsServer
          .sendCommand(member.deviceId, "sources.snapshot", { sources: memberSources })
          .catch(() => {});
      }
    }
  };

  handleDisconnected = (conn: DeviceConnection): void => {
    if (!scopeSatisfies(conn.scopes, SCOPE_WRITE_ALL)) return;
    void this.deviceDoctor?.onDeviceDisconnected(conn.deviceId).catch((err) => {
      log.warn(
        `Could not park an interrupted device doctor run: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
}

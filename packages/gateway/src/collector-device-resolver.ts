// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collector device resolution + pairing for the admin HTTP surface. Extracted
 * from the createServer composition root: these were closures over its scope, so
 * they take the same dependencies here and the admin routes consume the returned
 * resolvers exactly as before.
 */

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import {
  tryDeviceId,
  type DeviceCapability,
  type DeviceKind,
  type DeviceRecord,
  type DeviceId,
  type SourceId,
} from "@omnesis/types";
import {
  findDeviceByInstallId,
  findDeviceByName,
  getDevice,
  installIdFrom,
  listDevices,
  resolveDeviceName,
} from "./data/repositories/DeviceRepository.js";
import {
  getSource,
  listAllSourceMembers,
  listSources,
} from "./data/repositories/SourceRepository.js";
import type { WriteGate } from "./write-gate.js";
import type { DeviceWsServer } from "./ws.js";
import type { SyncStatusRegistry } from "./sync-status.js";

const log = createLogger("gateway:http");

export interface CollectorDeviceResolverDeps {
  db: Db;
  wsServer?: DeviceWsServer;
  syncStatus?: SyncStatusRegistry;
  jsonErr: (
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) => Response;
  writeGate: WriteGate;
}

export function createCollectorDeviceResolver(deps: CollectorDeviceResolverDeps) {
  const { db, wsServer, syncStatus, jsonErr, writeGate: w } = deps;
  /**
   * `device.capabilities.hostableSourceTypes` may be undeclared on a freshly
   * paired collector whose first WS hello hasn't landed yet. Treat undeclared
   * as "permit" — the WS dispatch will fail loudly if the type really isn't
   * supported. Returning true for that case keeps the gateway from rejecting
   * legitimate adds during the boot-time race.
   */
  function deviceAdvertisesType(dev: DeviceRecord, sourceType: string): boolean {
    const types = dev.capabilities.hostableSourceTypes;
    return !Array.isArray(types) || (types as string[]).includes(sourceType);
  }

  /**
   * Validate a caller-supplied deviceId: exists, is a collector, is online.
   * Returns the DeviceRecord or an error Response. Capability filtering, if
   * any, is layered on by callers.
   */
  function resolveExplicitDevice(requested: string): DeviceRecord | Response {
    const id = tryDeviceId(requested);
    if (!id) return jsonErr(404, "DEVICE_NOT_FOUND", "device not found");
    const dev = getDevice(db, id);
    if (!dev) return jsonErr(404, "DEVICE_NOT_FOUND", "device not found");
    if (dev.kind !== "collector") {
      return jsonErr(
        404,
        "DEVICE_NOT_COLLECTOR",
        `device "${dev.name}" has kind "${dev.kind}" — admin source actions require a collector`,
      );
    }
    if (dev.revokedAt !== null) {
      return jsonErr(
        409,
        "DEVICE_REVOKED",
        `device "${dev.name}" is revoked — pair it again to reclaim it, or forget it`,
      );
    }
    if (wsServer && !wsServer.isConnected(dev.id)) {
      return jsonErr(
        503,
        "DEVICE_NOT_CONNECTED",
        `device ${dev.name} (${dev.id}) is paired but not connected`,
      );
    }
    return dev;
  }

  /**
   * Fetch every paired collector + the subset currently connected over WS,
   * with a single SELECT. All resolvers below funnel through this so the
   * admin dispatch path never burns two round-trips on the same data.
   */
  function listCollectorsWithOnline(): { all: DeviceRecord[]; online: DeviceRecord[] } {
    // A revoked collector is not "paired": it can neither connect nor be
    // advised to reconnect.
    const all = listDevices(db).filter((d) => d.kind === "collector" && !d.revokedAt);
    const online = wsServer ? all.filter((d) => wsServer!.isConnected(d.id)) : all;
    return { all, online };
  }

  /** Standard "no collectors paired / online" responses, shared across resolvers. */
  function noCollectorResponseOrNull(all: DeviceRecord[], online: DeviceRecord[]): Response | null {
    if (all.length === 0) {
      return jsonErr(404, "NO_COLLECTOR_PAIRED", "no collector device paired");
    }
    if (online.length === 0) {
      return jsonErr(
        503,
        "NO_COLLECTOR_ONLINE",
        "collector device(s) paired but none are currently connected — start a collector or revoke the stale device(s) with 'cli devices revoke <id>'",
        { paired: all.map((d) => ({ id: d.id, name: d.name })) },
      );
    }
    return null;
  }

  /**
   * Generic resolver. Used by routes that carry no source-type signal
   * (descriptors, snapshot, debug, credentials). Picks the unique online
   * collector or surfaces a structured error.
   */
  async function resolveCollectorDeviceId(requested?: string): Promise<DeviceId | Response> {
    if (requested) {
      const r = resolveExplicitDevice(requested);
      return r instanceof Response ? r : r.id;
    }
    const { all, online } = listCollectorsWithOnline();
    const err = noCollectorResponseOrNull(all, online);
    if (err) return err;
    if (online.length === 1) return online[0].id;
    return jsonErr(
      400,
      "AMBIGUOUS_DEVICE",
      "multiple collectors connected — pass deviceId explicitly",
      { devices: online.map((d) => ({ id: d.id, name: d.name })) },
    );
  }

  /**
   * Source-type-aware resolver. Used by `/admin/sources/add` and
   * `/admin/auth-flows`. Filters candidates to collectors that advertise
   * the requested sourceType. If exactly one qualifies, it's picked
   * regardless of how many other collectors are online.
   */
  async function resolveCollectorDeviceIdForType(
    requested: string | undefined,
    sourceType: string,
  ): Promise<DeviceId | Response> {
    if (requested) {
      const r = resolveExplicitDevice(requested);
      if (r instanceof Response) return r;
      if (!deviceAdvertisesType(r, sourceType)) {
        return jsonErr(
          400,
          "DEVICE_CANNOT_HOST_TYPE",
          `device "${r.name}" does not host source type "${sourceType}"`,
          { sourceType, hostableSourceTypes: r.capabilities.hostableSourceTypes ?? [] },
        );
      }
      return r.id;
    }
    const { all, online } = listCollectorsWithOnline();
    const err = noCollectorResponseOrNull(all, online);
    if (err) return err;
    const capable = online.filter((d) => deviceAdvertisesType(d, sourceType));
    if (capable.length === 0) {
      return jsonErr(
        400,
        "NO_CAPABLE_DEVICE",
        `no online collector hosts source type "${sourceType}"`,
        {
          sourceType,
          online: online.map((d) => ({
            id: d.id,
            name: d.name,
            hostableSourceTypes: d.capabilities.hostableSourceTypes ?? [],
          })),
        },
      );
    }
    if (capable.length === 1) return capable[0].id;
    return jsonErr(
      400,
      "AMBIGUOUS_DEVICE",
      `multiple collectors host source type "${sourceType}" — pass deviceId explicitly`,
      { sourceType, devices: capable.map((d) => ({ id: d.id, name: d.name })) },
    );
  }

  /**
   * Reauth resolver. Used by `/admin/sources/reauth-finalize`. Picks a member
   * device that hosts a source matching `accountId` and, when supplied, the
   * auth-driving `sourceType`. The collector-
   * side reauth handler matches by (providerType, accountId) across its
   * in-memory source instances; the gateway dispatch only needs to land on
   * the right physical host.
   *
   * When an explicit `deviceId` is supplied, the resolver still verifies
   * it hosts a source for the account — without this check an operator
   * could write fresh tokens to a collector that owns zero sources for the
   * account, silently failing the reauth.
   */
  async function resolveCollectorDeviceIdForReauth(
    requested: string | undefined,
    accountId: string,
    sourceType?: string,
  ): Promise<DeviceId | Response> {
    const sources = listSources(db).filter(
      (s) => s.accountId === accountId && (sourceType === undefined || s.type === sourceType),
    );
    const membersBySource = listAllSourceMembers(db);
    const deviceIds = new Set(
      sources.flatMap((source) => [
        source.deviceId,
        ...(membersBySource.get(source.id) ?? []).filter((id) => id !== source.deviceId),
      ]),
    );
    const matchLabel = sourceType ? `${sourceType}:${accountId}` : accountId;

    if (requested) {
      const r = resolveExplicitDevice(requested);
      if (r instanceof Response) return r;
      if (!deviceIds.has(r.id)) {
        return jsonErr(
          400,
          "NO_MATCHING_SOURCE",
          `device "${r.name}" hosts no source matching "${matchLabel}"`,
          { accountId, sourceType, deviceId: r.id },
        );
      }
      return r.id;
    }

    if (deviceIds.size === 0) {
      return jsonErr(
        400,
        "NO_MATCHING_SOURCE",
        `no source exists matching "${matchLabel}" — reauth needs an existing source to know which device to dispatch to`,
        { accountId, sourceType },
      );
    }
    const { all } = listCollectorsWithOnline();
    const byId = new Map(all.map((d) => [d.id, d]));
    const onlineMatches: DeviceRecord[] = [];
    const offlineMatches: DeviceRecord[] = [];
    for (const id of deviceIds) {
      const dev = byId.get(id);
      if (!dev) continue;
      if (wsServer && !wsServer.isConnected(dev.id)) offlineMatches.push(dev);
      else onlineMatches.push(dev);
    }
    if (onlineMatches.length === 0) {
      return jsonErr(
        503,
        "DEVICE_NOT_CONNECTED",
        `device(s) hosting sources for "${matchLabel}" are offline`,
        {
          accountId,
          sourceType,
          devices: offlineMatches.map((d) => ({ id: d.id, name: d.name })),
        },
      );
    }
    if (onlineMatches.length === 1) return onlineMatches[0].id;
    return jsonErr(
      400,
      "AMBIGUOUS_DEVICE",
      `multiple devices host sources for "${matchLabel}" — pass deviceId explicitly`,
      {
        accountId,
        sourceType,
        devices: onlineMatches.map((d) => ({ id: d.id, name: d.name })),
      },
    );
  }

  /**
   * Pair-redeem helper. Resolves the device name, then adopts an existing
   * row or creates one. Adoption precedence:
   *   1. the client's per-install identity (`capabilities.installId`) —
   *      same kind;
   *   2. the device id the client says it was last paired as
   *      (`capabilities.previousDeviceId`) — same kind; this is how a row
   *      that predates install identities gets stamped with one;
   *   3. the resolved name — same kind, and not stamped with another
   *      install's identity (clients without an install identity, and the
   *      pre-identity rows they adopt);
   *   4. otherwise a fresh row.
   * A repair updates the row in place, keeping its id and its (possibly
   * renamed) name, so sources and anything keyed by deviceId stay attached;
   * old tokens are revoked. Returns a 409 when the adopted candidate is
   * currently online, or when the name belongs to a device of a different
   * kind.
   */
  async function createOrReplaceDeviceForPair(
    pendingName: string,
    kind: DeviceKind,
    capabilities: DeviceCapability,
  ): Promise<
    { device: DeviceRecord; replacedDeviceId?: DeviceId } | { error: string; status: 409 }
  > {
    const suggested = resolveDeviceName(pendingName, kind, capabilities);
    const candidate = adoptionCandidate(kind, capabilities, suggested);
    if (candidate) {
      const { device: existing, via } = candidate;
      if (existing.kind !== kind) {
        return {
          error: `Device name "${suggested}" is reserved by a ${existing.kind} device. Pick a different name or revoke the existing device first.`,
          status: 409,
        };
      }
      if (wsServer?.isConnected(existing.id)) {
        return {
          error:
            via === "name"
              ? `A ${existing.kind} device named "${existing.name}" is currently online. Pick a different name or revoke the existing device first.`
              : `This ${existing.kind} device ("${existing.name}") is currently online. Disconnect or revoke it before pairing it again.`,
          status: 409,
        };
      }
      const device = await w.replaceDeviceForRepair(existing.id, {
        name: existing.name,
        kind,
        capabilities,
      });
      log.info(
        `Repaired offline ${existing.kind} device ${device.id} in place (name="${device.name}", matched by ${via}, tokens revoked)`,
      );
      return { device, replacedDeviceId: existing.id };
    }
    // The suggested name may belong to a row this client must not adopt
    // (another install of the same kind); the fresh row then takes a
    // distinguishable name.
    const name = findDeviceByName(db, suggested)
      ? `${suggested}-${randomBytes(2).toString("hex")}`
      : suggested;
    const device = await w.createDevice({ name, kind, capabilities });
    return { device };
  }

  /** The existing row a pairing client should adopt, if any (see above). */
  function adoptionCandidate(
    kind: DeviceKind,
    capabilities: DeviceCapability,
    name: string,
  ): { device: DeviceRecord; via: "install" | "previous" | "name" } | null {
    const installId = installIdFrom(capabilities);
    if (installId) {
      const byInstall = findDeviceByInstallId(db, kind, installId);
      if (byInstall) return { device: byInstall, via: "install" };
    }
    const previousId = tryDeviceId(capabilities.previousDeviceId ?? "");
    if (previousId) {
      const previous = getDevice(db, previousId);
      if (previous && previous.kind === kind) return { device: previous, via: "previous" };
    }
    const byName = findDeviceByName(db, name);
    if (!byName) return null;
    // A same-kind row stamped with a different install identity belongs to
    // that install. A different-kind row is returned so the caller can
    // refuse the name.
    if (byName.kind === kind && byName.installId !== null && byName.installId !== installId) {
      return null;
    }
    return { device: byName, via: "name" };
  }

  /**
   * Resolve which device hosts a given source. Prefer the explicit
   * /admin/sources record; fall back to whichever device most recently
   * reported sync.status for it.
   */
  function deviceForSource(id: SourceId): DeviceId | null {
    const source = getSource(db, id);
    if (source) return source.deviceId;
    const discovered = syncStatus?.deviceFor(id);
    return discovered ?? null;
  }

  return {
    resolveCollectorDeviceId,
    resolveCollectorDeviceIdForType,
    resolveCollectorDeviceIdForReauth,
    createOrReplaceDeviceForPair,
    deviceForSource,
  };
}

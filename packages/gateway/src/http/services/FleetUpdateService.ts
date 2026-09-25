// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The fleet update: this gateway telling the devices it serves to bring
 * themselves to the build it is running.
 *
 * Nothing is downloaded here and no code crosses the socket. The command
 * carries either a release version or an exact source commit, and each device
 * runs its own local `omnesis update` against its own remote. Validation lives
 * on the device rather than here, because a gateway that has been tampered
 * with cannot be trusted to police itself.
 *
 * The ordinary portal/release target is always this gateway's own version.
 * The CLI-only exact-commit path first requires the running gateway to attest
 * that same commit, preserving the "gateway updates first" invariant.
 *
 * A device that is offline when the operator asks keeps the desired version
 * on its row and takes the command on its next connection.
 */

import {
  createLogger,
  planDeviceUpdate,
  planDeviceCommitUpdate,
  type FleetUpdateDisposition,
  type FleetUpdateEntry,
  type FleetUpdateOutcome,
  type FleetUpdatePlan,
} from "@omnesis/core";
import { type DeviceId, type DeviceRecord, type DeviceUpdateState } from "@omnesis/types";
import { WsCommandError } from "../../ws.js";
import { ConflictError } from "../errors.js";
import { GATEWAY_VERSION } from "../../version.js";
import { deviceVersionState } from "../../device-version.js";
import { getDevice, listDevices } from "../../data/repositories/DeviceRepository.js";
import type { VersionedDevice as VersionedDeviceRow } from "../../device-version.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";
import type { DeviceWsServer } from "../../ws.js";

const log = createLogger("gateway:http").child("fleet-update");

/** The slice of a device row a fleet-update disposition is computed from. */
type FleetUpdateDevice = VersionedDeviceRow & Pick<DeviceRecord, "updateState" | "capabilities">;

/**
 * How long a device has to acknowledge the command. It is a receipt, not the
 * update — the device answers as soon as it has started — so this is
 * deliberately short. A device that cannot answer in ten seconds is one the
 * operator should look at, not one to keep waiting on.
 */
const ACK_TIMEOUT_MS = 10_000;

/**
 * How long a dispatched update may be outstanding before a device that
 * reconnects on the old build is taken to mean it never landed.
 *
 * Comfortably past the budget the device itself gives the work, so a slow
 * install cannot be declared dead by a socket that merely blinked. A device
 * that finishes inside it reports its own outcome, which settles the row
 * without this ever being consulted.
 */
const STALE_DISPATCH_MS = 60 * 60 * 1_000;

/**
 * Whether a device's error answer means it has no handler for the update
 * command. Clients that route commands through a registry answer with the
 * `unsupported` code. A collector built before the command existed answers
 * its generic fallback instead — a `handler_error` naming the unknown command
 * — and, being already released, can never be taught the code.
 */
function isUnimplementedCommand(err: unknown): err is WsCommandError {
  if (!(err instanceof WsCommandError)) return false;
  if (err.code === "unsupported") return true;
  return err.code === "handler_error" && err.message.includes("Unknown command: device.update");
}

export interface FleetUpdateServiceDeps {
  db: Database.Database;
  writeGate: WriteGate;
  /**
   * Resolved on each use rather than held: the socket server is built after
   * the handlers that reach it, and a device with no server is simply one
   * whose update stays pending.
   */
  wsServer?: () => DeviceWsServer | undefined;
  /** Overridable so tests can drive a target other than this build's. */
  targetVersion?: string;
  /** Exact source commit this running gateway has attested, when source-managed. */
  sourceCommit?: string | null;
}

type FleetTarget = { kind: "release"; version: string } | { kind: "commit"; commit: string };

function targetKey(target: FleetTarget): string {
  return target.kind === "release" ? target.version : `commit:${target.commit}`;
}

function targetLabel(target: FleetTarget): string {
  return target.kind === "release" ? target.version : `commit ${target.commit.slice(0, 12)}`;
}

function storedTarget(value: string): FleetTarget {
  const commit = /^commit:([0-9a-f]{40})$/u.exec(value)?.[1];
  return commit ? { kind: "commit", commit } : { kind: "release", version: value };
}

/**
 * Every fact this service works from lives in `devices`, so it holds no state
 * of its own and two instances over one database cannot disagree. That is
 * what lets the WS hooks and the admin routes each construct their own rather
 * than thread one object through the boot order.
 */
export class FleetUpdateService {
  private readonly db: Database.Database;
  private readonly w: WriteGate;
  private readonly resolveWsServer: () => DeviceWsServer | undefined;
  readonly targetVersion: string;
  readonly sourceCommit: string | null;

  constructor(deps: FleetUpdateServiceDeps) {
    this.db = deps.db;
    this.w = deps.writeGate;
    this.resolveWsServer = deps.wsServer ?? (() => undefined);
    this.targetVersion = deps.targetVersion ?? GATEWAY_VERSION;
    this.sourceCommit = deps.sourceCommit ?? null;
  }

  private assertRunningCommit(commit: string): void {
    if (this.sourceCommit !== commit) {
      throw new ConflictError(
        this.sourceCommit
          ? `The running gateway is on commit ${this.sourceCommit.slice(0, 12)}, not ${commit.slice(0, 12)}.`
          : "The running gateway cannot attest an installer-managed source commit.",
      );
    }
  }

  /**
   * What this gateway would do about one device row. Pure over the row, so
   * the admin device list can attach it to rows it already has cached.
   */
  dispositionFor(
    device: FleetUpdateDevice,
    target: FleetTarget = { kind: "release", version: this.targetVersion },
  ): FleetUpdateDisposition {
    const candidate = {
      deviceKind: device.kind,
      versionState: deviceVersionState(device),
      reportedVersion: device.version,
      sourceCommit: device.capabilities.sourceCommit ?? null,
      revoked: device.revokedAt !== null,
      updateState: device.updateState,
      harness: device.capabilities.agentIntegration?.harness ?? null,
    };
    return target.kind === "release"
      ? planDeviceUpdate(candidate, target.version)
      : planDeviceCommitUpdate(candidate, target.commit);
  }

  /**
   * Every device and what this gateway would do about it. Read straight from
   * the table rather than the admin status cache: a plan is read on demand —
   * when an operator asks for one, or every few seconds while
   * `omnesis update --fleet` waits for devices to reconnect after a gateway
   * restart — and it must reflect the version and connection a device
   * reported seconds ago rather than up to a tick earlier.
   */
  plan(targetVersion: string = this.targetVersion): FleetUpdatePlan {
    return { targetVersion, devices: this.entries({ kind: "release", version: targetVersion }) };
  }

  /** CLI-only exact-commit plan; the portal continues to call {@link plan}. */
  planCommit(commit: string): FleetUpdatePlan {
    this.assertRunningCommit(commit);
    return {
      targetVersion: this.targetVersion,
      targetCommit: commit,
      devices: this.entries({ kind: "commit", commit }),
    };
  }

  /** The plan's rows, with the device ids still branded for internal use. */
  private entries(
    target: FleetTarget = { kind: "release", version: this.targetVersion },
  ): Array<FleetUpdateEntry & { id: DeviceId }> {
    return listDevices(this.db).map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      version: d.version,
      online: this.resolveWsServer()?.isConnected(d.id) ?? false,
      disposition: this.dispositionFor(d, target),
      desiredVersion: d.desiredVersion,
      updateState: d.updateState,
      updateDetail: d.updateDetail,
    }));
  }

  /**
   * Ask the named devices to update themselves — or, with no ids, every
   * device the plan says is commandable and behind.
   *
   * Each target is re-checked against the plan rather than trusted from the
   * caller: the id may have arrived from a stale page, and the refusals are
   * safety rules, not UI hints.
   *
   * `allowRewind` is the operator's explicit permission, given on the host
   * they updated first, for a target that is neither a newer release nor a
   * descendant of a device's build. It travels only with a command sent now:
   * a device parked while offline is later asked without it, and refuses
   * such a target again rather than rewinding on a permission it never saw.
   */
  async request(
    deviceIds?: readonly DeviceId[],
    target: FleetTarget = { kind: "release", version: this.targetVersion },
    options: { allowRewind?: boolean } = {},
  ): Promise<FleetUpdateOutcome[]> {
    if (target.kind === "commit") this.assertRunningCommit(target.commit);
    const entries = this.entries(target);
    const wanted = deviceIds ? new Set<string>(deviceIds) : null;
    const targets = entries.filter((entry) =>
      wanted ? wanted.has(entry.id) : entry.disposition.kind === "update",
    );

    const outcomes: FleetUpdateOutcome[] = [];
    // An id naming no device is answered rather than dropped: silence would
    // read as success to whoever sent it.
    const known = new Set<string>(entries.map((entry) => entry.id));
    for (const id of deviceIds ?? []) {
      if (!known.has(id)) {
        outcomes.push({ id, name: id, state: "refused", detail: "No such device." });
      }
    }
    for (const entry of targets) {
      if (entry.disposition.kind === "refused") {
        outcomes.push({
          id: entry.id,
          name: entry.name,
          state: "refused",
          detail: entry.disposition.reason,
        });
        continue;
      }
      if (entry.disposition.kind === "current") {
        outcomes.push({
          id: entry.id,
          name: entry.name,
          state: "current",
          detail: `Already on ${targetLabel(target)}.`,
        });
        continue;
      }
      outcomes.push(await this.commandOne(entry.id, entry.name, target, options));
    }
    return outcomes;
  }

  /**
   * Deliver (or park) one device's update.
   *
   * The row is claimed before the command is sent, not after, and the claim
   * is a compare-and-set. Two operators pressing "Update all" at once, or a
   * device holding two sockets whose reconnects both settle, would otherwise
   * each read a `pending` row and each send a command; and a claim written
   * after the acknowledgement can arrive behind the result of an update that
   * already finished. Only the writer that moves the row into its next state
   * proceeds — everybody else is told the update is already under way.
   *
   * The device is read again here rather than trusted from the plan:
   * `request` awaits each acknowledgement in turn, and devices reconnect in
   * that window after a gateway restart — online now, and possibly already on
   * the target. A device parked as offline is checked once more after the
   * park, because a hello that completed between the check and the park
   * looked for a parked request before there was one and will not look again
   * until the next reconnect; that hello's handling is run for it instead.
   */
  private async commandOne(
    id: DeviceId,
    name: string,
    target: FleetTarget,
    options: { allowRewind?: boolean } = {},
  ): Promise<FleetUpdateOutcome> {
    const row = getDevice(this.db, id);
    if (row && this.dispositionFor(row, target).kind === "current") {
      return {
        id,
        name,
        state: "current",
        detail: `Already on ${targetLabel(target)}.`,
      };
    }
    const wsServer = this.resolveWsServer();
    if (!wsServer || !wsServer.isConnected(id)) {
      const parked = await this.park(id, name, target);
      if (parked.state !== "pending" || !wsServer?.isConnected(id)) return parked;
      log.info(`${name} connected while its update was being parked; settling it now`);
      await this.onDeviceConnected(id);
      return this.outcomeOf(id, name);
    }
    // Claimed as dispatched before the send: a device that answers instantly
    // and reports instantly can otherwise have its result overwritten by the
    // news that the command arrived.
    const claimed = await this.claim(id, "dispatched", null, target);
    if (!claimed) return this.alreadyUnderWay(id, name);
    return this.dispatch(id, name, wsServer, target, options);
  }

  /** What the row now says about this request, as an outcome. */
  private outcomeOf(id: DeviceId, name: string): FleetUpdateOutcome {
    const row = getDevice(this.db, id);
    const detail = row?.updateDetail ?? undefined;
    return { id, name, state: row?.updateState ?? "pending", ...(detail ? { detail } : {}) };
  }

  /** Park the update on the row, to be sent when the device next connects. */
  private async park(id: DeviceId, name: string, target: FleetTarget): Promise<FleetUpdateOutcome> {
    const claimed = await this.claim(id, "pending", null, target);
    if (!claimed) return this.alreadyUnderWay(id, name);
    log.info(`Update to ${targetLabel(target)} pending for ${name} — offline`);
    return {
      id,
      name,
      state: "pending",
      detail: "Offline. The update is sent when this device reconnects.",
    };
  }

  /**
   * Take the row for this request, but only from a state that means nothing
   * is under way: never asked, parked while offline, or settled by a previous
   * attempt. A row already `dispatched` belongs to an update in flight.
   */
  private async claim(
    id: DeviceId,
    state: DeviceUpdateState,
    detail: string | null,
    target: FleetTarget,
  ): Promise<boolean> {
    return this.w.setDeviceUpdateRequest(id, {
      desiredVersion: targetKey(target),
      state,
      detail,
      notIfState: "dispatched",
    });
  }

  private alreadyUnderWay(id: DeviceId, name: string): FleetUpdateOutcome {
    const detail = "An update is already under way on this device.";
    log.info(`${name} was not commanded: ${detail}`);
    return { id, name, state: "dispatched", detail };
  }

  /**
   * Send the command on a live socket. The row already says `dispatched`, so
   * what this records is only the exceptions: a device that refuses, and a
   * socket that went away before the command landed.
   */
  private async dispatch(
    id: DeviceId,
    name: string,
    wsServer: DeviceWsServer,
    target: FleetTarget,
    options: { allowRewind?: boolean } = {},
  ): Promise<FleetUpdateOutcome> {
    const rewind = options.allowRewind ? { allowRewind: true as const } : {};
    try {
      const ack = await wsServer.sendCommand(
        id,
        "device.update",
        target.kind === "release"
          ? { version: target.version, ...rewind }
          : { commit: target.commit, ...rewind },
        ACK_TIMEOUT_MS,
      );
      if (ack.accepted) {
        log.info(`${name} is updating itself to ${targetLabel(target)}`);
        return { id, name, state: "dispatched" };
      }
      const detail = ack.reason ?? "The device would not start the update.";
      await this.settle(id, "failed", detail, target);
      log.warn(`${name} refused the update to ${targetLabel(target)}: ${detail}`);
      return { id, name, state: "failed", detail };
    } catch (err) {
      // A refusal and a lost socket are different outcomes, and neither is
      // parked: a device that answered is never coming back with a result, so
      // parking the request would re-send it on every reconnect forever. Only
      // a transport failure is parked.
      //
      // A build that does not implement the command at all — an older
      // client, or a harness plugin without it — is recorded as its own state
      // rather than a failure, because nothing went wrong and nothing will
      // change until that machine is updated by hand; the plan refuses the
      // device while it runs this build. Any other error is a command the
      // device understood and rejected.
      const message = err instanceof Error ? err.message : String(err);
      if (isUnimplementedCommand(err)) {
        await this.settle(id, "unsupported", "This build does not accept update commands.", target);
        log.info(`${name} cannot be updated remotely: ${message}`);
        // The operator reads the refusal the settled row produces, which names
        // the commands for this device's kind — unless a result raced the
        // settle, in which case the row's own detail is the better account.
        const row = getDevice(this.db, id);
        const disposition = row ? this.dispositionFor(row, target) : null;
        const detail =
          disposition?.kind === "refused" && disposition.code === "command-unsupported"
            ? disposition.reason
            : (row?.updateDetail ?? "This build does not accept update commands.");
        return { id, name, state: "unsupported", detail };
      }
      if (err instanceof WsCommandError) {
        const detail = `The device rejected the update command (${err.code}).`;
        await this.settle(id, "failed", detail, target);
        log.warn(`${name} rejected the update command: ${message}`);
        return { id, name, state: "failed", detail };
      }
      const detail = "The device went offline before the command landed; it is sent on reconnect.";
      await this.settle(id, "pending", detail, target);
      log.warn(`Could not deliver the update command to ${name}: ${message}`);
      return { id, name, state: "pending", detail };
    }
  }

  /**
   * Move the row out of the `dispatched` state this attempt claimed, and only
   * out of that one — a result the device sent while this was in flight has
   * already settled it, and is the better answer.
   */
  private async settle(
    id: DeviceId,
    state: DeviceUpdateState,
    detail: string,
    target: FleetTarget,
  ): Promise<void> {
    await this.w.setDeviceUpdateRequest(id, {
      desiredVersion: targetKey(target),
      state,
      detail,
      onlyIfState: "dispatched",
      onlyIfDesiredVersion: targetKey(target),
    });
  }

  /**
   * Called after a device completes its hello. Three things a reconnect can
   * settle: the device came back on the version it was asked for, which
   * closes the request; it came back on the old one after a dispatch, which
   * means the update did not survive whatever restarted it; or it never
   * received the command and takes it now.
   */
  async onDeviceConnected(id: DeviceId): Promise<void> {
    // Read through, not from the status cache. The hello has just written
    // this device's version and the cache only refreshes on a two-second
    // tick, so the cached row is exactly the reading this method must not
    // trust — a device that came back updated would look unchanged.
    const device = getDevice(this.db, id);
    if (!device || device.revokedAt !== null) return;
    // Older terminal results discarded their target. They can only be
    // reconciled once this device is confirmed current for this gateway.
    const legacyResult =
      !device.desiredVersion &&
      (device.updateState === "failed" || device.updateState === "restart-pending");
    if (!device.desiredVersion && !legacyResult) return;
    const desired = device.desiredVersion ?? this.targetVersion;
    const target = storedTarget(desired);
    const state = this.dispositionFor(device, target);
    if (state.kind === "current") {
      const settled = await this.w.setDeviceUpdateRequest(id, {
        desiredVersion: null,
        state: "installed",
        detail: legacyResult
          ? `Reconnected on current build ${device.version}. Earlier update result: ${device.updateDetail ?? device.updateState}.`
          : `Reconnected on ${targetLabel(target)}.`,
        ...(device.updateState ? { onlyIfState: device.updateState } : {}),
        onlyIfDesiredVersion: device.desiredVersion,
        onlyIfReportedVersion: device.version,
        ...(target.kind === "commit"
          ? { onlyIfSourceCommit: device.capabilities.sourceCommit ?? null }
          : {}),
      });
      if (settled) {
        log.info(`${device.name} came back on ${targetLabel(target)}`);
      } else {
        log.debug(`${device.name}'s reconnect settlement lost a newer row change`);
      }
      return;
    }
    if (state.kind === "refused" || legacyResult) return;

    // Still behind, and a command was already sent.
    //
    // Most of the time that is not a failure: the update is minutes of `npm
    // ci` and a build, the device holds its socket throughout, and any drop
    // in that window reconnects on the old build simply because the new one
    // is not loaded yet. So this waits out the device's own budget before
    // concluding anything — long enough that an update still running cannot
    // be mistaken for one that died.
    //
    // Past it, the request is recorded as failed rather than left reading
    // "dispatched" forever, which is indistinguishable from an update still
    // running. The version stays owed: a late result, or a hello on the new
    // build, then still closes the row honestly instead of leaving a
    // successful update permanently recorded as a failure.
    // `installed` is here too: a device that reported the build in place and
    // then keeps coming back without it did not land it either, and that row
    // would otherwise sit owing a version nothing will ever resolve.
    if (device.updateState === "dispatched" || device.updateState === "installed") {
      const outstandingFor = Date.now() - (device.updateStateAt ?? 0);
      if (outstandingFor < STALE_DISPATCH_MS) return;
      const failed = await this.w.setDeviceUpdateRequest(id, {
        desiredVersion: desired,
        state: "failed",
        detail: `Reconnected without ${targetLabel(target)} — the update did not land.`,
        onlyIfState: device.updateState,
        onlyIfDesiredVersion: desired,
        onlyIfReportedVersion: device.version,
        ...(target.kind === "commit"
          ? { onlyIfSourceCommit: device.capabilities.sourceCommit ?? null }
          : {}),
      });
      if (failed) {
        log.warn(`${device.name} came back without the update to ${targetLabel(target)}`);
      } else {
        log.debug(`${device.name}'s stale reconnect result lost a newer build report`);
      }
      return;
    }
    // Only a request that never landed is re-sent.
    if (device.updateState !== "pending") return;
    const wsServer = this.resolveWsServer();
    if (!wsServer) return;
    if (!(await this.claim(id, "dispatched", null, target))) return;
    await this.dispatch(id, device.name, wsServer, target);
  }

  /**
   * Record what a device said about the update it ran.
   *
   * A result is only accepted against an outstanding request for the version
   * it names. Every paired device can emit this event, including kinds this
   * gateway never commands, and the detail it carries is shown to the
   * operator — so an unprompted or stale report writes nothing.
   */
  async recordResult(
    id: DeviceId,
    result: ({ version: string } | { commit: string }) & {
      state: "installed" | "restart-pending" | "failed";
      detail?: string;
    },
  ): Promise<void> {
    const device = getDevice(this.db, id);
    if (!device || device.revokedAt !== null) return;
    const target: FleetTarget =
      "version" in result
        ? { kind: "release", version: result.version }
        : { kind: "commit", commit: result.commit };
    const key = targetKey(target);
    if (device.desiredVersion !== key) {
      log.debug(
        `Ignoring an update result from ${device.name} for ${targetLabel(target)}: nothing was asked`,
      );
      return;
    }
    // The hello writes the running version before its reconnect hook settles
    // this request. A result sent by that newly loaded client can race the
    // hook: without resolving it here too, a late restart-pending or failed
    // report can replace the successful reconnect and leave a current device
    // claiming that work is still owed. Both paths converge on the same
    // terminal row, guarded by both facts that justified the settlement.
    const disposition = this.dispositionFor(device, target);
    if (disposition.kind === "current") {
      const settled = await this.w.setDeviceUpdateRequest(id, {
        desiredVersion: null,
        state: "installed",
        detail: `Reconnected on ${targetLabel(target)}.`,
        onlyIfDesiredVersion: key,
        onlyIfReportedVersion: device.version,
        ...(target.kind === "commit"
          ? { onlyIfSourceCommit: device.capabilities.sourceCommit ?? null }
          : {}),
      });
      if (settled) {
        log.info(
          `${device.name} already runs ${targetLabel(target)}; ignoring its late ${result.state} result`,
        );
      } else {
        log.debug(`${device.name}'s late-result settlement lost a newer row change`);
      }
      return;
    }
    // A row already failed for this version was written by the device's own
    // host while the commanded run was still going (its updater exits clean
    // even when a plugin refresh inside it did not), and the host's account
    // is the more specific one. Only a new dispatch moves the row on.
    if (device.updateState === "failed" && result.state !== "failed") {
      log.info(
        `Keeping ${device.name}'s failed result for ${targetLabel(target)} over a ${result.state} report`,
      );
      return;
    }
    // Keep the target even after failure or a manual-restart requirement:
    // a later hello can prove recovery. Only pending requests are dispatched
    // on reconnect, so retaining the target does not retry a failed command.
    await this.w.setDeviceUpdateRequest(id, {
      desiredVersion: key,
      state: result.state,
      detail: result.detail ?? null,
      ...(device.updateState ? { onlyIfState: device.updateState } : {}),
      onlyIfDesiredVersion: key,
    });
    log.info(`${device.name} reported ${result.state} for ${targetLabel(target)}`);
  }

  /**
   * Record an update a device's own host ran on it: `omnesis update` on a
   * harness host refreshing the agent plugin, whether the operator ran it or
   * the plugin's own self-updater did on this gateway's command. The device's
   * own credential authorized the write, and the version reported becomes
   * the one owed, so the device's next hello on it closes the row exactly as
   * a commanded update's would, and a hello on an older build leaves the
   * record standing. A request this gateway has outstanding for another
   * version is not displaced: that run reports on itself. A device already
   * running the reported version has loaded that plugin, so a host run that
   * refreshed it again owes no restart and writes nothing, and neither does a
   * restart-pending against an update parked for the same version, which the
   * parked command delivers. Returns false when nothing was written.
   */
  async recordLocalResult(
    id: DeviceId,
    result: { version: string; state: "restart-pending" | "failed"; detail?: string },
  ): Promise<boolean> {
    const device = getDevice(this.db, id);
    if (!device || device.revokedAt !== null) return false;
    if (result.state === "restart-pending" && device.version === result.version) {
      log.info(
        `Ignoring ${device.name}'s local restart-pending for ${result.version}: it already runs that version`,
      );
      return false;
    }
    // A request parked for this same version is what restarts the harness:
    // its plugin installs the build (already on disk, so quickly) and then
    // restarts itself. A host run that refreshed the plugin first owes that
    // same restart, and recording it would settle the row so that the parked
    // command is never sent.
    if (
      result.state === "restart-pending" &&
      device.desiredVersion === result.version &&
      device.updateState === "pending"
    ) {
      log.info(
        `Keeping ${device.name}'s parked update to ${result.version} over its host's restart-pending: the command restarts it`,
      );
      // A row parks while its device is connected when an acknowledgement
      // timed out, and nothing then sends it until the next hello. The
      // restart is owed now, so the command goes now.
      if (this.resolveWsServer()?.isConnected(id)) await this.onDeviceConnected(id);
      return false;
    }
    const outstanding =
      device.desiredVersion !== null &&
      device.desiredVersion !== result.version &&
      (device.updateState === "pending" || device.updateState === "dispatched");
    if (outstanding) {
      log.info(
        `Ignoring ${device.name}'s local result for ${result.version}: an update to ${device.desiredVersion} is outstanding`,
      );
      return false;
    }
    await this.w.setDeviceUpdateRequest(id, {
      desiredVersion: result.version,
      state: result.state,
      detail: result.detail ?? null,
    });
    log.info(`${device.name} reported ${result.state} for ${result.version} from its own host`);
    return true;
  }
}

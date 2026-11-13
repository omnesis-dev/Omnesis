// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { hasPerDeviceCursor, memberResyncModes, type ResyncMode } from "@omnesis/types";
import {
  c,
  gatewayFetch,
  resolvePatterns,
  buildCliFx,
  iconFor,
  isJSON,
  withSpinner,
  pickGatewayExitCode,
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
} from "../utils.js";
import {
  deviceLabel,
  loadSourcesAndDevices,
  readGatewayError,
  requireMemberDevice,
  sourceMode,
  type AdminDeviceEntry,
  type AdminSourceEntry,
} from "./members.js";

const USAGE =
  "Usage: omnesis sources resync <pattern> [pattern...] [--from-scratch] [--device <name|id>] [--yes]";

/**
 * The slice the gateway sent back to the start before it sent the sync: the
 * whole source, one device's stream (a partitioned source), or one device's
 * cursor alone (a replicated source, whose members all hold the same
 * documents).
 */
export type ResyncScope = "source" | "stream" | "cursor";

/**
 * The body of a successful `POST /admin/sources/:id/resync`: the mode that
 * was applied and the slice it applied to, then each online member's answer
 * to the sync that followed. A member in none of the lists was offline; it
 * syncs on its own schedule.
 */
export interface ResyncBody {
  ok: true;
  /**
   * `from-scratch` deleted the slice first; `in-place` deleted nothing.
   * Absent from a gateway that only resyncs from scratch — read it through
   * `appliedMode`.
   */
  mode?: ResyncMode;
  scope: ResyncScope;
  /** The members that started a fresh sync. */
  deviceIds: string[];
  /** The members that aborted the sync they had in flight and start over once it has stopped. */
  restarting: string[];
  /** The members that were already syncing and left the command alone. */
  skipped: string[];
  /** The members on which the source is paused; it re-syncs there once resumed. */
  disabled: string[];
}

/** The way out of a refused per-device resync, appended to every refusal that has one. */
const RESYNC_WITHOUT_DEVICE = "Resync it without --device.";

/**
 * The refusal for a `--device` on a source whose members share one cursor:
 * there is no per-device position to reset, so the only resync is the whole
 * source's.
 */
export function sharedCursorRefusal(source: Pick<AdminSourceEntry, "id" | "multiDeviceMode">) {
  return (
    `${source.id} syncs as ${sourceMode(source)}: its members share one cursor, ` +
    `so there is no per-device resync.\n${RESYNC_WITHOUT_DEVICE}`
  );
}

/** The refusal for a `--device` that does not host the source. Names the devices that do. */
export function notMemberRefusal(
  source: Pick<AdminSourceEntry, "id">,
  device: Pick<AdminDeviceEntry, "name">,
  memberNames: readonly string[],
): string {
  return `${device.name} does not host ${source.id} — members: ${memberNames.join(", ")}`;
}

/**
 * The refusal for `--from-scratch --device` on a replicated source: the
 * member shares its documents with its siblings, so there is nothing of its
 * own to delete.
 */
export function replicatedFromScratchRefusal(
  source: Pick<AdminSourceEntry, "id">,
  device: Pick<AdminDeviceEntry, "name">,
): string {
  return (
    `${device.name} shares the documents of ${source.id} with the other members, so there is nothing of its own to delete.\n` +
    `Resync it in place (drop --from-scratch), or resync the whole source from scratch (drop --device).`
  );
}

/**
 * The refusal for an in-place resync against a gateway whose source listing
 * names no resync modes: that gateway wipes on every resync, whatever it is
 * asked, so the request is never sent.
 */
export function inPlaceUnsupportedRefusal(source: Pick<AdminSourceEntry, "id">): string {
  return (
    `This gateway can only resync ${source.id} from scratch, which deletes its data first.\n` +
    `Update the gateway to resync in place, or re-run with --from-scratch.`
  );
}

/**
 * The confirmation question a from-scratch resync asks: the whole source
 * without a device, that member's contribution with one. An in-place resync
 * deletes nothing and asks nothing.
 */
export function confirmMessage(target: string, device?: Pick<AdminDeviceEntry, "name">): string {
  if (!device) {
    return `This will delete all data for ${target} and import it again from scratch. Continue?`;
  }
  return (
    `This removes everything ${device.name} contributed to ${target} and imports it again from that device; ` +
    `the other members' data stays. Continue?`
  );
}

/**
 * The mode a resync was carried out in. A gateway that names none wiped the
 * slice, except a replicated member's cursor, which has nothing to wipe.
 */
export function appliedMode(body: Pick<ResyncBody, "mode" | "scope">): ResyncMode {
  return body.mode ?? (body.scope === "cursor" ? "in-place" : "from-scratch");
}

/** What the gateway did before it sent the sync, in one sentence. */
function resyncSummary(body: ResyncBody, device?: Pick<AdminDeviceEntry, "name">): string {
  const name = device?.name;
  if (appliedMode(body) === "from-scratch") {
    return body.scope === "source"
      ? "Every document of the source was deleted."
      : `Everything ${name ?? "the device"} contributed was removed; the other members' data stays.`;
  }
  switch (body.scope) {
    case "source":
      return "Nothing was deleted; the source is read again and updates the records already here.";
    case "stream":
      return `Nothing was deleted; ${name ?? "the device"} reads the source again and updates what it contributed.`;
    case "cursor":
      return `${name ?? "The device"}'s sync position was reset; nothing was deleted.`;
  }
}

/**
 * The lines printed once a resync went through: what each member did with
 * the sync — started it, is restarting the one it had in flight, was already
 * syncing and skipped it, or has the source paused and re-syncs it once
 * resumed — then what the gateway did first in plain words. `device` is the
 * member the resync was scoped to, when it was.
 */
export function renderResync(
  body: ResyncBody,
  idLabel: string,
  deviceName: (id: string) => string,
  device?: Pick<AdminDeviceEntry, "name">,
): string[] {
  const names = (ids: readonly string[]) => ids.map(deviceName).join(", ");
  const verdicts = [
    body.deviceIds.length > 0 ? `sent to ${names(body.deviceIds)}` : "",
    body.restarting.length > 0 ? `restarting the sync in flight on ${names(body.restarting)}` : "",
    body.skipped.length > 0
      ? `${names(body.skipped)} ${body.skipped.length === 1 ? "was" : "were"} already syncing`
      : "",
    body.disabled.length > 0
      ? `the source is paused on ${names(body.disabled)}; it re-syncs when resumed`
      : "",
  ].filter(Boolean);
  let head: string;
  if (verdicts.length === 0) {
    head = `${c.green}${device ? `Resync queued; ${device.name} is offline` : "Resync queued; no member is online"}`;
  } else if (body.deviceIds.length > 0 || body.restarting.length > 0) {
    head = `${c.green}Resync ${verdicts.join("; ")}`;
  } else if (body.skipped.length > 0) {
    head = `${c.yellow}Resync skipped; ${verdicts.join("; ")}`;
  } else {
    // Only paused members answered: the sync waits, as it does for an offline one.
    head = `${c.yellow}Resync queued; ${verdicts.join("; ")}`;
  }
  const lines = [`${head}:${c.reset} ${idLabel}`];
  lines.push(`${c.dim}${resyncSummary(body, device)}${c.reset}`);
  return lines;
}

/**
 * `omnesis sources resync <pattern...> [--from-scratch] [--device <name|id>]`
 * — resync matching sources through `POST /admin/sources/:id/resync`, one
 * request per source. In place unless `--from-scratch`: nothing is deleted,
 * each source is read again from the start and every item updates the record
 * it already has. `--from-scratch` deletes the source's data first and asks
 * for confirmation. With `--device` the resync is scoped to that member,
 * which only a mode with per-device cursors allows: a device that is not a
 * member, a source whose members share one cursor, or a from-scratch resync
 * of a replicated member is refused before any request, and the gateway's
 * own refusals are rendered the same way. `--device` takes one source, since
 * what it does depends on that source's mode. With `--json`, each source's
 * result is printed as one JSON line.
 */
export const resyncCommand = defineCommand({
  meta: {
    name: "resync",
    description:
      "Read matching sources again from the start (in place; --from-scratch deletes their data first)",
  },
  args: {
    "from-scratch": {
      type: "boolean",
      description:
        "Delete the source's data first, then import everything again (new records; individually deleted items come back)",
    },
    device: {
      type: "string",
      description: "Resync one member only (with --from-scratch, a partitioned member only)",
    },
    yes: { type: "boolean", alias: "y", description: "Skip the --from-scratch confirmation" },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const patterns = ((ctx.args._ as string[] | undefined) ?? []).filter((a) => !a.startsWith("-"));
    if (patterns.length === 0) {
      throw new CliError(
        `${c.red}${USAGE}${c.reset}\n\n` +
          `Reads matching sources again from the start and updates the records already indexed.\n` +
          `Nothing is deleted: records keep their ids, items you deleted stay deleted, and search\n` +
          `keeps working meanwhile. It does not clear duplicate or stray records.\n\n` +
          `With --from-scratch, everything indexed from the source is deleted first and imported\n` +
          `again: search for it is empty until that finishes, and items you had deleted one by one\n` +
          `come back.\n\n` +
          `With --device, only that member is resynced.\n\n` +
          `Examples:\n` +
          `  ${c.cyan}omnesis sources resync gmail:user@gmail.com${c.reset}        Resync a source in place\n` +
          `  ${c.cyan}omnesis sources resync gmail:${c.reset}                      Resync all Gmail accounts\n` +
          `  ${c.cyan}omnesis sources resync apple: --from-scratch${c.reset}       Delete and import again\n` +
          `  ${c.cyan}omnesis sources resync health:me --device Phone${c.reset}    Resync one member only\n\n` +
          `Run ${c.cyan}omnesis sources${c.reset} to see available source IDs.`,
        EXIT_USER_ERROR,
      );
    }
    const mode: ResyncMode = ctx.args["from-scratch"] === true ? "from-scratch" : "in-place";
    const json = ctx.args.json === true;

    const { sources, devices } = await loadSourcesAndDevices();
    if (sources.length === 0) {
      throw new CliError(
        `${c.red}No sources registered with the gateway.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const sourceIds = resolvePatterns(
      patterns,
      sources.map((s) => ({ id: s.id, providerId: s.type })),
    );
    if (sourceIds.length === 0) {
      throw new CliError(
        `${c.red}No sources match: ${patterns.join(", ")}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const targets = sourceIds.map((id) => sources.find((s) => s.id === id)!);

    let device: AdminDeviceEntry | undefined;
    if (ctx.args.device !== undefined) {
      if (targets.length > 1) {
        throw new CliError(
          `${c.red}--device resyncs one source at a time; ${patterns.join(", ")} matches ${targets.length}: ` +
            `${sourceIds.join(", ")}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      device = requireMemberDevice(devices, ctx.args.device, USAGE);
      const source = targets[0]!;
      if (!hasPerDeviceCursor(sourceMode(source))) {
        throw new CliError(`${c.red}${sharedCursorRefusal(source)}${c.reset}`, EXIT_USER_ERROR);
      }
      if (!source.members.includes(device.id)) {
        const names = source.members.map((id) => deviceLabel(devices, id));
        throw new CliError(
          `${c.red}${notMemberRefusal(source, device, names)}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      if (!memberResyncModes(sourceMode(source)).includes(mode)) {
        throw new CliError(
          `${c.red}${replicatedFromScratchRefusal(source, device)}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
    }
    if (mode === "in-place") {
      const wipesOnly = targets.find((source) => source.resyncModes === undefined);
      if (wipesOnly) {
        throw new CliError(
          `${c.red}${inPlaceUnsupportedRefusal(wipesOnly)}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
    }

    const fx = await buildCliFx();
    const iconPrefixFor = (id: string): string => {
      const icon = iconFor(id, fx);
      return icon ? `${icon} ` : "";
    };

    // Confirm before a wipe — unless `--yes`. A non-interactive run (piped or
    // `--json`) never blocks on a prompt: it needs `--yes` so a script cannot
    // hang. An in-place resync deletes nothing, so it runs unasked.
    if (mode === "from-scratch" && ctx.args.yes !== true) {
      if (isJSON || !process.stdout.isTTY) {
        throw new CliError(
          `${c.red}Refusing to resync from scratch without confirmation. Re-run with --yes.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      if (sourceIds.length > 1) {
        for (const id of sourceIds) console.log(`  ${iconPrefixFor(id)}${c.dim}${id}${c.reset}`);
      }
      const target = sourceIds.length === 1 ? sourceIds[0]! : `these ${sourceIds.length} sources`;
      const prompts = await import("@clack/prompts");
      const answer = await prompts.confirm({
        message: confirmMessage(target, device),
        initialValue: false,
      });
      if (prompts.isCancel(answer) || answer !== true) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
    }

    const deviceName = (id: string): string => deviceLabel(devices, id);
    const failures: Array<{ id: string; exitCode: number }> = [];
    for (const source of targets) {
      const res = await withSpinner(`Resyncing ${source.id}`, () =>
        gatewayFetch(`/admin/sources/${encodeURIComponent(source.id)}/resync`, {
          method: "POST",
          body: JSON.stringify(device ? { deviceId: device.id, mode } : { mode }),
        }),
      );
      if (!res.ok) {
        const body = await readGatewayError(res);
        // The two per-device refusals are the operator's to act on and mirror
        // the checks above; the listing was stale if the gateway raised them,
        // so the mode refusal repeats the gateway's sentence rather than the
        // listing's mode.
        let message: string;
        if (body.code === "RESYNC_NOT_PER_DEVICE") {
          message = `${body.error}\n${RESYNC_WITHOUT_DEVICE}`;
        } else if (body.code === "DEVICE_NOT_MEMBER" && device) {
          const names = source.members.map(deviceName);
          message = notMemberRefusal(source, device, names);
        } else {
          message = `Resync failed for ${source.id}: ${body.error}`;
        }
        console.error(`${c.red}${message}${c.reset}`);
        failures.push({ id: source.id, exitCode: pickGatewayExitCode(res.status) });
        continue;
      }
      const body = (await res.json()) as ResyncBody;
      if (json) {
        console.log(JSON.stringify({ sourceId: source.id, ...body }));
        continue;
      }
      const idLabel = `${iconPrefixFor(source.id)}${c.bold}${source.id}${c.reset}`;
      for (const line of renderResync(body, idLabel, deviceName, device)) console.log(line);
    }
    if (failures.length > 0) {
      throw new CliError(
        targets.length > 1
          ? `${c.red}${failures.length} of ${targets.length} sources did not resync: ${failures.map((f) => f.id).join(", ")}${c.reset}`
          : "",
        failures[0]!.exitCode,
      );
    }
  },
});

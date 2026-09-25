// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  withSpinner,
  pickGatewayExitCode,
  CliError,
  EXIT_USER_ERROR,
  EXIT_CANCELLED,
} from "../utils.js";
import {
  deviceLabel,
  loadSourceContext,
  readGatewayError,
  requireMemberDevice,
  type AdminDeviceEntry,
  type AdminSourceEntry,
  assertCliManagedSource,
} from "./members.js";

const USAGE = "Usage: omnesis sources detach <id> --device <name|id> [--yes] [--json]";

/** The lines printed once a device has been detached. */
export function renderDetached(
  source: Pick<AdminSourceEntry, "id" | "multiDeviceMode">,
  device: Pick<AdminDeviceEntry, "name">,
  remaining: number,
): string[] {
  const remain = remaining === 1 ? "1 member remains" : `${remaining} members remain`;
  const data =
    "The gateway retains shared indexed data and removes only the departing device's partitioned contribution, according to its current source mode. Other members' data stays.";
  return [
    `${c.green}✓${c.reset} ${device.name} detached from ${c.bold}${source.id}${c.reset} ${c.dim}(${remain})${c.reset}`,
    `${c.dim}${data}${c.reset}`,
  ];
}

/**
 * `omnesis sources detach <id> --device <name|id>` — remove a device from a
 * source's membership. The other members keep syncing; the documents stay,
 * except on a partitioned source, whose detached device takes its own stream
 * with it. The last member cannot leave: pause keeps its data, while
 * `omnesis sources remove` deletes the whole source.
 */
export const detachSourceCommand = defineCommand({
  meta: {
    name: "detach",
    description: "Remove a device from a source's members",
  },
  args: {
    id: { type: "positional", description: "Source id", required: true },
    device: { type: "string", description: "Device to detach (name or id)" },
    yes: {
      type: "boolean",
      description: "Confirm detach, including device-data deletion if partitioned",
    },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const sourceId = String(ctx.args.id);
    const json = ctx.args.json === true;
    const { source, devices } = await loadSourceContext(sourceId);
    assertCliManagedSource(source);
    const device = requireMemberDevice(devices, ctx.args.device, USAGE);

    if (!source.members.includes(device.id)) {
      const members = source.members.map((id) => deviceLabel(devices, id)).join(", ");
      throw new CliError(
        `${c.red}${device.name} does not host ${source.id} — members: ${members}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    if (ctx.args.yes !== true) {
      if (json) {
        throw new CliError(
          `Detaching ${device.name} from ${source.id} keeps shared data but deletes its managed gateway contribution if the source is partitioned when the gateway handles the request; other members' data stays. Repeat with --yes to confirm. Originals, backups and exports are not deleted; this is not physical secure erasure.`,
          EXIT_USER_ERROR,
        );
      }
      const prompts = await import("@clack/prompts");
      const confirmed = await prompts.confirm({
        message: `Detach ${device.name} from ${source.id}? Shared data stays; if partitioned when the gateway handles the request, delete its managed gateway contribution. Other members' data stays. Ownership passes to a remaining member if needed; the last member cannot detach. Offline devices reconcile on reconnect. Originals, backups and exports are not deleted; this is not physical secure erasure.`,
      });
      if (prompts.isCancel(confirmed) || !confirmed) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
    }

    const res = await withSpinner(`Detaching ${device.name} from ${source.id}`, () =>
      gatewayFetch(
        `/admin/sources/${encodeURIComponent(source.id)}/members/${encodeURIComponent(device.id)}`,
        { method: "DELETE" },
      ),
    );
    if (!res.ok) {
      const body = await readGatewayError(res);
      // LAST_MEMBER and DEVICE_NOT_MEMBER are the operator's to act on and the
      // gateway's message already names the alternative, so it stands alone.
      const operatorError = body.code === "LAST_MEMBER" || body.code === "DEVICE_NOT_MEMBER";
      throw new CliError(
        `${c.red}${operatorError ? body.error : `Detach failed for ${source.id}: ${body.error}`}${c.reset}`,
        operatorError ? EXIT_USER_ERROR : pickGatewayExitCode(res.status),
      );
    }
    const { members } = (await res.json()) as { members: string[] };
    if (json) {
      console.log(JSON.stringify({ sourceId: source.id, deviceId: device.id, members }));
      return;
    }
    for (const line of renderDetached(source, device, members.length)) console.log(line);
  },
});

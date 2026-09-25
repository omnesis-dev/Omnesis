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
} from "../utils.js";
import {
  deviceLabel,
  loadSourceContext,
  readGatewayError,
  requireMemberDevice,
  sourceMode,
  type AdminDeviceEntry,
  type AdminSourceEntry,
  type TargetDevice,
  assertCliManagedSource,
} from "./members.js";

const USAGE = "Usage: omnesis sources join <id> --device <name|id> [--json]";

/**
 * The refusal for an exclusive source: it has one host, and the only way to
 * put it on another device is a move, which lands it on a collector. Names
 * the host, and spells out the move command when the device is a collector.
 * A device whose kind the listing did not carry gets the refusal alone — the
 * second sentence turns on the kind, so guessing one would make it a lie.
 */
export function exclusiveRefusal(
  sourceId: string,
  hostName: string,
  device: Pick<TargetDevice, "name" | "kind">,
): string {
  const lead = `${sourceId} is hosted by ${hostName} and its type allows one host at a time.`;
  if (device.kind === undefined) return lead;
  return device.kind === "collector"
    ? `${lead}\nTo move it: omnesis sources move ${sourceId} --device ${device.name}`
    : `${lead}\n${device.name} is a ${device.kind} device and cannot host it.`;
}

/**
 * The refusal for a device the gateway's listing does not count among the
 * source's join candidates: a collector that does not offer the type, or a
 * device of a kind that only hosts the sources it pushes itself. Names the
 * devices that could join instead.
 */
export function notCandidateRefusal(
  source: Pick<AdminSourceEntry, "id" | "type">,
  device: Pick<TargetDevice, "name" | "kind">,
  candidateNames: readonly string[],
): string {
  const why =
    device.kind === "collector"
      ? `its collector does not offer ${source.type} sources.`
      : device.kind === undefined
        ? `it does not host ${source.type} sources.`
        : `a ${device.kind} device does not host ${source.type} sources.`;
  const instead =
    candidateNames.length > 0
      ? `Devices that can join: ${candidateNames.join(", ")}`
      : "No other device can join it.";
  return `${device.name} cannot host ${source.id}: ${why}\n${instead}`;
}

/** The lines printed once a device has joined. */
export function renderJoined(
  source: Pick<AdminSourceEntry, "id" | "type" | "pushBased">,
  device: Pick<TargetDevice, "name" | "online">,
  memberCount: number,
): string[] {
  const lines = [
    `${c.green}✓${c.reset} ${device.name} joined ${c.bold}${source.id}${c.reset} ${c.dim}(${memberCount} members)${c.reset}`,
  ];
  // Only a device the listing reports as away gets the note; one whose
  // presence is unknown is not announced as offline.
  if (device.online === false) {
    lines.push(
      `${c.dim}${device.name} is offline — it picks the source up when it reconnects.${c.reset}`,
    );
  }
  if (!source.pushBased) {
    lines.push(
      `${c.dim}If ${source.type} needs a sign-in, run: omnesis sources reauth ${source.id} --device ${device.name}${c.reset}`,
    );
  }
  return lines;
}

/**
 * Ask the gateway to add `device` as a member of `source`, and return the
 * membership it answers with. A refusal becomes a user error in the words the
 * pre-checks use: the gateway's SOURCE_ALREADY_HOSTED is the exclusive
 * refusal, naming the host it reports; anything else is surfaced as sent.
 */
export async function requestJoin(
  source: Pick<AdminSourceEntry, "id" | "deviceId">,
  device: Pick<TargetDevice, "id" | "name" | "kind">,
  devices: readonly AdminDeviceEntry[],
  memberConfig?: Record<string, unknown>,
): Promise<string[]> {
  const res = await gatewayFetch(`/admin/sources/${encodeURIComponent(source.id)}/members`, {
    method: "POST",
    body: JSON.stringify({ deviceId: device.id, ...(memberConfig ? { memberConfig } : {}) }),
  });
  if (!res.ok) {
    const body = await readGatewayError(res);
    if (body.code === "SOURCE_ALREADY_HOSTED") {
      const detail = body.detail as { currentDeviceName?: string | null } | undefined;
      const host = detail?.currentDeviceName ?? deviceLabel(devices, source.deviceId);
      throw new CliError(
        `${c.red}${exclusiveRefusal(source.id, host, device)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    throw new CliError(
      `${c.red}Join failed for ${source.id}: ${body.error}${c.reset}`,
      pickGatewayExitCode(res.status),
    );
  }
  const { members } = (await res.json()) as { members: string[] };
  return members;
}

/** Replace one existing member's host-local overlay. */
export async function requestMemberConfigUpdate(
  sourceId: string,
  deviceId: string,
  configOverride: Record<string, unknown>,
): Promise<void> {
  const res = await gatewayFetch(
    `/admin/sources/${encodeURIComponent(sourceId)}/members/${encodeURIComponent(deviceId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ configOverride }),
    },
  );
  if (res.ok) return;
  const body = await readGatewayError(res);
  throw new CliError(
    `${c.red}Member configuration failed for ${sourceId}: ${body.error}${c.reset}`,
    pickGatewayExitCode(res.status),
  );
}

/** Persist the descriptor's explicit multi-device mode on an existing source. */
export async function requestModeTransition(
  sourceId: string,
  multiDeviceMode: Exclude<AdminSourceEntry["multiDeviceMode"], undefined>,
): Promise<AdminSourceEntry> {
  const res = await gatewayFetch(`/admin/sources/${encodeURIComponent(sourceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ multiDeviceMode }),
  });
  if (!res.ok) {
    const body = await readGatewayError(res);
    throw new CliError(
      `${c.red}Could not enable ${multiDeviceMode} mode for ${sourceId}: ${body.error}${c.reset}`,
      pickGatewayExitCode(res.status),
    );
  }
  const { source } = (await res.json()) as { source: AdminSourceEntry };
  return source;
}

/**
 * `omnesis sources join <id> --device <name|id>` — add a device as a member
 * of a source another device already hosts. The joiner syncs with its own
 * credentials; what the members do with the shared source depends on the
 * type's multi-device mode. An exclusive source, and a device the listing
 * does not count as a candidate, are refused before any request is sent;
 * the gateway's own refusal is rendered the same way.
 */
export const joinSourceCommand = defineCommand({
  meta: {
    name: "join",
    description: "Add a device as a member of a source another device hosts",
  },
  args: {
    id: { type: "positional", description: "Source id", required: true },
    device: { type: "string", description: "Device to join (name or id)" },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const sourceId = String(ctx.args.id);
    const json = ctx.args.json === true;
    const { source, devices } = await loadSourceContext(sourceId);
    assertCliManagedSource(source);
    const device = requireMemberDevice(devices, ctx.args.device, USAGE);

    if (source.members.includes(device.id)) {
      if (json) {
        console.log(
          JSON.stringify({
            sourceId: source.id,
            deviceId: device.id,
            joined: false,
            members: source.members,
          }),
        );
        return;
      }
      console.log(`${c.yellow}${device.name} is already a member of ${source.id}.${c.reset}`);
      return;
    }

    if (sourceMode(source) === "exclusive") {
      throw new CliError(
        `${c.red}${exclusiveRefusal(source.id, deviceLabel(devices, source.deviceId), device)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (source.joinCandidates && !source.joinCandidates.includes(device.id)) {
      const names = source.joinCandidates.map((id) => deviceLabel(devices, id));
      throw new CliError(
        `${c.red}${notCandidateRefusal(source, device, names)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const members = await withSpinner(`Joining ${device.name} to ${source.id}`, () =>
      requestJoin(source, device, devices),
    );
    if (json) {
      console.log(
        JSON.stringify({ sourceId: source.id, deviceId: device.id, joined: true, members }),
      );
      return;
    }
    for (const line of renderJoined(source, device, members.length)) console.log(line);
  },
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineCommand } from "citty";
import { c, gatewayJson, buildCliFx, iconFor, withSpinner } from "../utils.js";
import {
  attentionPhrase,
  renderMembers,
  sourceMode,
  type AdminDeviceEntry,
  type AdminSourceEntry,
  type MemberSyncStatus,
} from "./members.js";

type AdminSource = Omit<AdminSourceEntry, "members"> & {
  accountId: string;
  /** Absent from gateway versions that predate multi-device membership. */
  members?: string[];
};

/**
 * A source whose removal has been accepted but whose data purge is still
 * draining. It has no `sources` row left, so it is listed from the gateway's
 * `pendingRemovals` rather than joined onto one.
 */
interface PendingRemoval {
  id: string;
  type: string;
  accountId: string;
  state: "removing";
}

function isPendingRemoval(s: AdminSource | PendingRemoval): s is PendingRemoval {
  return "state" in s && s.state === "removing";
}

/**
 * `omnesis sources` — list source instances registered with the gateway.
 *
 * This is gateway-only. The "available source types" listing
 * (which providers can be added) used to come from the collector via
 * /sources; that lives at the device's hello capabilities now and isn't
 * surfaced here. Use `omnesis sources add` for the interactive picker.
 */
export const sourcesListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List source instances registered with the gateway",
  },
  async run() {
    const [
      { items: registered, pendingRemovals = [] },
      { items: devices },
      { items: statuses },
      fx,
    ] = await withSpinner("Loading sources", () =>
      Promise.all([
        gatewayJson<{ items: AdminSource[]; pendingRemovals?: PendingRemoval[] }>("/admin/sources"),
        gatewayJson<{ items: AdminDeviceEntry[] }>("/admin/devices").catch(() => ({
          items: [] as AdminDeviceEntry[],
        })),
        gatewayJson<{ items: MemberSyncStatus[] }>("/admin/sync/status").catch(() => ({
          items: [] as MemberSyncStatus[],
        })),
        buildCliFx(),
      ]),
    );

    const deviceById = new Map(devices.map((d) => [d.id, d.name]));
    const statusBySourceId = new Map(statuses.map((status) => [status.sourceId, status]));

    if (registered.length === 0 && pendingRemovals.length === 0) {
      console.log(
        `\n${c.dim}No sources registered. Use ${c.reset}omnesis sources add <source>${c.dim} to add one.${c.reset}\n`,
      );
      return;
    }

    // Group by source type. Draining removals are grouped alongside live
    // sources so the operator sees the id they just removed still accounted
    // for, rather than gone from the list while its data is still on disk.
    const byType = new Map<string, Array<AdminSource | PendingRemoval>>();
    for (const s of [...registered, ...pendingRemovals]) {
      const list = byType.get(s.type) ?? [];
      list.push(s);
      byType.set(s.type, list);
    }
    const types = Array.from(byType.keys()).sort();

    console.log(`\n${c.bold}Sources${c.reset}\n`);

    for (const type of types) {
      const instances = byType.get(type)!;
      // Group header: one icon for the source type, then the type name.
      const typeIcon = iconFor(type, fx);
      const typeIconPrefix = typeIcon ? `${typeIcon} ` : "";
      console.log(`  ${typeIconPrefix}${c.bold}${type}${c.reset}`);
      for (const s of instances) {
        if (isPendingRemoval(s)) {
          console.log(
            `    ${c.red}◌${c.reset} ${c.dim}${s.id}${c.reset} ${c.red}(removing — deleting its data)${c.reset}`,
          );
          continue;
        }
        const trouble = s.enabled ? attentionPhrase(statusBySourceId.get(s.id)) : undefined;
        const dot = !s.enabled
          ? `${c.dim}○${c.reset}`
          : trouble
            ? `${c.red}●${c.reset}`
            : `${c.green}●${c.reset}`;
        const tag = !s.enabled
          ? ` ${c.dim}(paused)${c.reset}`
          : trouble
            ? ` ${c.red}(${trouble})${c.reset}`
            : "";
        const source = { ...s, members: s.members ?? [s.deviceId] };
        if (sourceMode(source) !== "exclusive" || source.members.length > 1) {
          const [heading, ...memberLines] = renderMembers(
            source,
            devices,
            statusBySourceId.get(source.id),
          );
          console.log(`    ${dot} ${heading}${tag}`);
          for (const line of memberLines) console.log(`    ${line}`);
          continue;
        }
        const dev = deviceById.get(source.deviceId) ?? source.deviceId.slice(0, 8);
        console.log(`    ${dot} ${c.dim}${source.id}${c.reset} on ${c.cyan}${dev}${c.reset}${tag}`);
      }
      console.log();
    }
    console.log(`${c.dim}Add new sources with 'omnesis sources add <source>'.${c.reset}\n`);
  },
});

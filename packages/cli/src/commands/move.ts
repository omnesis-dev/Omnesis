// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayJson,
  gatewayFetch,
  buildCliFx,
  iconFor,
  withSpinner,
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
} from "../utils.js";

interface AdminSource {
  id: string;
  type: string;
  deviceId: string;
}

interface AdminDevice {
  id: string;
  name: string;
  kind: string;
  online?: boolean;
  revokedAt?: number | null;
}

/**
 * Resolve the `--device` flag against the paired collectors, by exact id or
 * name. Returns the match, or an error message listing what exists so the
 * user can correct the flag without a second round-trip.
 */
export function resolveMoveTarget(
  collectors: readonly AdminDevice[],
  deviceFlag: string,
): { target: AdminDevice } | { error: string } {
  const target = collectors.find((d) => d.id === deviceFlag || d.name === deviceFlag);
  if (!target) {
    return {
      error: `No collector matches "${deviceFlag}" — paired collectors: ${
        collectors.map((d) => d.name).join(", ") || "(none)"
      }`,
    };
  }
  return { target };
}

/**
 * `omnesis sources move <id> --device <collector>` — re-home a source to a
 * different collector.
 *
 * A source belongs to exactly one device; adding the same account on a
 * second collector is refused rather than silently adopted. This command is
 * the explicit hand-over: it PATCHes the source's deviceId, which registers
 * the source on the gaining collector and unregisters it on the losing one
 * (documents and on-disk credentials stay put — the new host authenticates
 * with its own credentials if it doesn't have them yet).
 */
export const moveSourceCommand = defineCommand({
  meta: {
    name: "move",
    description: "Move a source to a different collector",
  },
  args: {
    device: {
      type: "string",
      description: "Target collector (name or id)",
    },
  },
  async run(ctx) {
    const prompts = await import("@clack/prompts");
    const positionals = (ctx.args._ as string[]).filter((a) => !a.startsWith("-"));

    const [{ items: sources }, { items: devices }] = await withSpinner(
      "Loading sources and devices",
      () =>
        Promise.all([
          gatewayJson<{ items: AdminSource[] }>("/admin/sources"),
          gatewayJson<{ items: AdminDevice[] }>("/admin/devices"),
        ]),
    );
    if (sources.length === 0) {
      console.log(`${c.yellow}No sources registered.${c.reset}`);
      return;
    }
    const deviceName = (id: string): string => devices.find((d) => d.id === id)?.name ?? id;

    // Resolve the source: explicit id, or interactive pick.
    let sourceId = positionals[0];
    if (sourceId && !sources.some((s) => s.id === sourceId)) {
      throw new CliError(`${c.red}No source with id: ${sourceId}${c.reset}`, EXIT_USER_ERROR);
    }
    if (!sourceId) {
      const selected = await prompts.select({
        message: "Which source would you like to move?",
        options: sources.map((s) => ({
          value: s.id,
          label: `${s.id} ${c.dim}(on ${deviceName(s.deviceId)})${c.reset}`,
        })),
      });
      if (prompts.isCancel(selected)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      sourceId = selected as string;
    }
    const source = sources.find((s) => s.id === sourceId);
    if (!source)
      throw new CliError(`${c.red}No source with id: ${sourceId}${c.reset}`, EXIT_USER_ERROR);

    // Resolve the target collector: --device by name or id, or interactive
    // pick among the collectors that don't already host the source.
    // Revoked collectors can't sync anything — never offer them as a target.
    const collectors = devices.filter((d) => d.kind === "collector" && !d.revokedAt);
    const deviceFlag = typeof ctx.args.device === "string" ? ctx.args.device : undefined;
    let target: AdminDevice | undefined;
    if (deviceFlag) {
      const resolved = resolveMoveTarget(collectors, deviceFlag);
      if ("error" in resolved) {
        throw new CliError(`${c.red}${resolved.error}${c.reset}`, EXIT_USER_ERROR);
      }
      target = resolved.target;
    } else {
      const candidates = collectors.filter((d) => d.id !== source.deviceId);
      if (candidates.length === 0) {
        throw new CliError(
          `${c.red}No other collector to move ${source.id} to.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const selected = await prompts.select({
        message: `Move ${source.id} from ${deviceName(source.deviceId)} to:`,
        options: candidates.map((d) => ({
          value: d.id,
          label: `${d.name}${d.online ? "" : ` ${c.dim}(offline)${c.reset}`}`,
        })),
      });
      if (prompts.isCancel(selected)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      target = collectors.find((d) => d.id === selected);
      if (!target) throw new CliError(`${c.red}Device not found.${c.reset}`, EXIT_USER_ERROR);
    }

    if (target.id === source.deviceId) {
      console.log(`${c.yellow}${source.id} already lives on ${target.name}.${c.reset}`);
      return;
    }

    const fx = await buildCliFx();
    const icon = iconFor(source.id, fx);
    const iconPrefix = icon ? `${icon} ` : "";
    const res = await withSpinner(`Moving ${source.id} to ${target.name}`, () =>
      gatewayFetch(`/admin/sources/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ deviceId: target.id }),
      }),
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new CliError(
        `${c.red}Move failed for ${iconPrefix}${source.id}: ${body.error ?? res.status}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    console.log(
      `${c.green}Moved:${c.reset} ${iconPrefix}${source.id} ${c.dim}${deviceName(
        source.deviceId,
      )} →${c.reset} ${target.name}`,
    );
    if (!target.online) {
      console.log(
        `${c.dim}${target.name} is offline — it picks the source up when it reconnects.${c.reset}`,
      );
    }
    console.log(
      `${c.dim}If the source needs credentials (OAuth), run: omnesis sources reauth on ${target.name}.${c.reset}`,
    );
  },
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayJson,
  gatewayFetch,
  resolvePatterns,
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
  enabled: boolean;
}

export const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a source and delete its ingested data",
  },
  async run(ctx) {
    const patterns = (ctx.args._ as string[]).filter((a) => !a.startsWith("--"));
    const prompts = await import("@clack/prompts");

    const { items: sources } = await withSpinner("Loading sources", () =>
      gatewayJson<{ items: AdminSource[] }>("/admin/sources"),
    );
    if (sources.length === 0) {
      console.log(`${c.yellow}No sources registered.${c.reset}`);
      return;
    }

    let matches: string[];
    if (patterns.length === 0) {
      const selected = await prompts.multiselect({
        message: "Which sources would you like to remove?",
        options: sources.map((s) => ({
          value: s.id,
          label: `${s.id}${s.enabled ? "" : ` ${c.dim}(paused)${c.reset}`}`,
        })),
        required: true,
      });
      if (prompts.isCancel(selected)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      matches = selected as string[];
    } else {
      matches = resolvePatterns(
        patterns,
        sources.map((s) => ({ id: s.id, providerId: s.type })),
      );
      if (matches.length === 0) {
        throw new CliError(
          `${c.red}No source matches: ${patterns.join(", ")}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
    }

    const fx = await buildCliFx();

    if (matches.length > 1) {
      for (const m of matches) {
        const icon = iconFor(m, fx);
        console.log(`  ${icon ? `${icon} ` : ""}${c.dim}${m}${c.reset}`);
      }
    }
    const confirm = await prompts.confirm({
      message: `Remove ${matches.length === 1 ? matches[0] : `these ${matches.length} sources`}? ${c.yellow}The whole source is removed for every device, including offline members. All managed gateway data will be deleted. Originals on the provider or phone, retained backups and exported copies are not deleted; this is not physical secure erasure.${c.reset}`,
    });
    if (prompts.isCancel(confirm) || !confirm) {
      prompts.cancel("Cancelled.");
      throw new CliError("", EXIT_CANCELLED);
    }

    let removed = 0;
    for (const id of matches) {
      const icon = iconFor(id, fx);
      const iconPrefix = icon ? `${icon} ` : "";
      // Deleting the registry record is the whole removal: the gateway stops
      // the source, dispatches `source.removed` to the host collector (which
      // unregisters + cleans up credentials), and then purges the documents,
      // analytics and index entries in the background.
      const remRes = await withSpinner(`Removing ${id}`, () =>
        gatewayFetch(`/admin/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
      );
      if (!remRes.ok) {
        const body = (await remRes.json().catch(() => ({}))) as { error?: string };
        console.error(
          `${c.red}Remove failed for ${iconPrefix}${id}: ${body.error ?? remRes.status}${c.reset}`,
        );
        continue;
      }
      removed += 1;
      console.log(`${c.red}Removed:${c.reset} ${iconPrefix}${id}`);
    }
    if (removed > 0) {
      // The purge outlives this command, and `omnesis sources` reports the
      // source as `removing` until it drains — so say so rather than let the
      // lingering row read as a failed removal.
      console.log(
        `${c.dim}Deleting ingested data in the background; ${removed === 1 ? "the source disappears" : "the sources disappear"} from \`omnesis sources\` once that completes. Re-add is blocked until cleanup completes.${c.reset}`,
      );
    }
    console.log();
  },
});

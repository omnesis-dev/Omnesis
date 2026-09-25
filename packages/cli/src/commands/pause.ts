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

/**
 * `omnesis sources pause` — pauses sync for one or more sources.
 *
 * Pausing keeps everything in place (OAuth tokens, cursor, indexed
 * documents) and just stops the sync timer until `resume`. The wire/DB
 * field stays `enabled: false` for backward compatibility — only the
 * user-facing label changed (was: `disable`).
 */
export const pauseSourceCommand = defineCommand({
  meta: {
    name: "pause",
    description: "Pause sync for one or more sources, keeping data and cursors",
  },
  async run(ctx) {
    const patterns = ctx.args._ as string[];
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
      const runningSources = sources.filter((s) => s.enabled);
      if (runningSources.length === 0) {
        console.log(`${c.yellow}No running sources to pause.${c.reset}`);
        return;
      }
      const selected = await prompts.multiselect({
        message: "Which sources would you like to pause?",
        options: runningSources.map((s) => ({ value: s.id, label: s.id })),
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
    for (const id of matches) {
      const icon = iconFor(id, fx);
      const iconPrefix = icon ? `${icon} ` : "";
      const res = await withSpinner(`Pausing ${id}`, () =>
        gatewayFetch(`/admin/sources/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        }),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(
          `${c.red}Pause failed for ${iconPrefix}${id}: ${body.error ?? res.status}${c.reset}`,
        );
        continue;
      }
      console.log(
        `${c.yellow}Paused:${c.reset} ${iconPrefix}${id} — indexed data and cursors kept`,
      );
    }
    console.log();
  },
});

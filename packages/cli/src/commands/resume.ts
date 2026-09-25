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
 * `omnesis sources resume` — resumes sync for previously-paused sources. The
 * wire/DB field stays `enabled: true` (legacy name); user-facing label
 * is "resume" (was: `enable`).
 */
export const resumeSourceCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Resume sync for previously-paused sources",
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
      const pausedSources = sources.filter((s) => !s.enabled);
      if (pausedSources.length === 0) {
        console.log(`${c.yellow}No paused sources to resume.${c.reset}`);
        return;
      }
      const selected = await prompts.multiselect({
        message: "Which sources would you like to resume?",
        options: pausedSources.map((s) => ({ value: s.id, label: s.id })),
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
      const res = await withSpinner(`Resuming ${id}`, () =>
        gatewayFetch(`/admin/sources/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: true }),
        }),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(
          `${c.red}Resume failed for ${iconPrefix}${id}: ${body.error ?? res.status}${c.reset}`,
        );
        continue;
      }
      console.log(`${c.green}Resumed:${c.reset} ${iconPrefix}${id}`);
    }
    console.log();
  },
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { c, isJSON, gw, withSpinner, CliError, EXIT_GATEWAY_ERROR } from "../utils.js";

export const healthCommand = defineCommand({
  meta: {
    name: "health",
    description: "Check gateway health",
  },
  args: {
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run() {
    const res = await withSpinner("Checking gateway health", () => gw("/health"));
    const data = (await res.json()) as Record<string, unknown>;
    if (isJSON) {
      console.log(JSON.stringify({ ok: res.ok, ...data }));
    } else {
      console.log(
        `Gateway: ${res.ok ? `${c.green}healthy${c.reset}` : `${c.red}unhealthy${c.reset}`}`,
      );
    }
    if (!res.ok) throw new CliError("", EXIT_GATEWAY_ERROR);
  },
});

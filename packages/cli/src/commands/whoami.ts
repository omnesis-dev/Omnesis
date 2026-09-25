// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { c, CliError, EXIT_AUTH, EXIT_GATEWAY_ERROR, gw, isJSON, withSpinner } from "../utils.js";

interface WhoAmI {
  tokenId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  scopes: string[];
}

export const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show current token, device, and scopes",
  },
  args: {
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run() {
    const res = await withSpinner("Resolving identity", () => gw("/whoami"));
    if (!res.ok) {
      if (res.status === 401) {
        throw new CliError(
          "Unauthorized — no valid token. Set OMNESIS_TOKEN or pair a device.",
          EXIT_AUTH,
        );
      }
      throw new CliError(`Gateway returned ${res.status}`, EXIT_GATEWAY_ERROR);
    }

    const data = (await res.json()) as WhoAmI;

    if (isJSON) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`\n${c.bold}Identity${c.reset}\n`);
    console.log(
      `  ${c.dim}Device:${c.reset}   ${data.deviceName ?? `${c.dim}(portal session)${c.reset}`}`,
    );
    if (data.deviceId) console.log(`  ${c.dim}Device ID:${c.reset} ${data.deviceId}`);
    if (data.tokenId) console.log(`  ${c.dim}Token ID:${c.reset}  ${data.tokenId}`);
    console.log(
      `  ${c.dim}Scopes:${c.reset}    ${data.scopes.length ? data.scopes.join(", ") : `${c.dim}(none)${c.reset}`}`,
    );
    console.log();
  },
});

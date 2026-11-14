// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// `omnesis cloud incidents`: what the certificate monitor found, and the one
// place the owner lifts the incident hold it puts the gateway on. The gateway
// refuses the acknowledgement when it arrives through its relay, so this works
// from the gateway host (or another machine on the home network), never from
// a CLI that reaches the gateway by its relay address.

import { defineCommand } from "citty";
import { CliError, EXIT_AUTH } from "@omnesis/cli-shared";
import { manageCloud, requireCloudRelay } from "./cloud-management.js";
import { incidentLines, type CloudStatus } from "./cloud-status.js";

export async function showIncidents(): Promise<void> {
  requireCloudRelay();
  const { gatewayJson } = await import("../utils.js");
  const lines = incidentLines(await gatewayJson<CloudStatus>("/admin/cloud-relay"));
  process.stdout.write(
    lines.length > 0 ? lines.join("\n") + "\n" : "No certificate incidents recorded.\n",
  );
}

export async function acknowledgeIncidents(json = false): Promise<void> {
  try {
    await manageCloud("incidents/ack", {}, { json });
  } catch (error) {
    if (error instanceof CliError && error.message.includes("local-request-required"))
      throw new CliError(
        "The gateway refused: certificate incidents can only be acknowledged on the gateway itself. Run this on the gateway host, not through its relay address.",
        EXIT_AUTH,
      );
    throw error;
  }
}

export const cloudIncidentCommands = {
  incidents: defineCommand({
    meta: {
      name: "incidents",
      description:
        "Certificates for this gateway's address with a key it doesn't hold, and the hold they put on new devices",
    },
    subCommands: {
      list: defineCommand({
        meta: {
          name: "list",
          description: "Show recorded incidents and whether new devices are held",
        },
        run: () => showIncidents(),
      }),
      ack: defineCommand({
        meta: {
          name: "ack",
          description:
            "After looking into an incident, let new devices follow your new-device setting again. Only works on the gateway itself",
        },
        args: {
          json: {
            type: "boolean",
            default: false,
            description: "Print the gateway's status as JSON",
          },
        },
        run: ({ args }) => acknowledgeIncidents(args.json),
      }),
    },
  }),
};

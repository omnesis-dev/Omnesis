// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { defineCommand } from "citty";
import { experimentalEnabled } from "@omnesis/core";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";

/** All actions use the same authenticated gateway control plane as the portal. */
export async function manageCloud(
  action: "status" | "configure" | "enable" | "disable" | "reconnect" | "renew",
  body?: unknown,
): Promise<void> {
  if (!experimentalEnabled())
    throw new CliError("Cloud management requires OMNESIS_EXPERIMENTAL=1", EXIT_USER_ERROR);
  const { gatewayJson } = await import("../utils.js");
  const result = await gatewayJson(
    `/admin/cloud-relay${action === "status" ? "" : `/${action}`}`,
    action === "status"
      ? {}
      : {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        },
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
export const cloudManagementCommands = {
  status: defineCommand({
    meta: {
      name: "status",
      description: "Show relay enrollment, tunnel and independent TLS identities",
    },
    run: () => manageCloud("status"),
  }),
  configure: defineCommand({
    meta: {
      name: "configure",
      description: "Prepare this gateway's optional managed relay identity",
    },
    args: {
      relay: {
        type: "string",
        description:
          "Legacy service assertion; must match this gateway installation (does not select a relay)",
      },
      origin: { type: "string" },
      "acme-directory": { type: "string" },
      "accept-terms": { type: "boolean", default: false },
    },
    run: ({ args }) =>
      manageCloud("configure", {
        relayUrl: args.relay,
        publicOrigin: args.origin,
        acmeDirectoryUrl: args["acme-directory"],
        termsAccepted: args["accept-terms"],
      }),
  }),
  enable: defineCommand({
    meta: {
      name: "enable",
      description: "Enroll and connect without changing direct gateway access",
    },
    args: {
      "invitation-file": {
        type: "string",
        description: "Private file containing the one-time invitation (never a command-line token)",
      },
    },
    async run({ args }) {
      let invitation: string | undefined;
      if (args["invitation-file"]) {
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of createReadStream(args["invitation-file"])) {
            bytes += chunk.length;
            if (bytes > 8192) throw new Error();
            chunks.push(chunk);
          }
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            !value ||
            typeof value !== "object" ||
            !("enrollmentToken" in value) ||
            typeof value.enrollmentToken !== "string" ||
            !value.enrollmentToken ||
            value.enrollmentToken.length > 4096
          )
            throw new Error();
          invitation = value.enrollmentToken;
        } catch {
          throw new CliError("Invalid enrollment invitation file", EXIT_USER_ERROR);
        }
      }
      await manageCloud("enable", { invitation });
    },
  }),
  disable: defineCommand({
    meta: {
      name: "disable",
      description: "Stop relay activity while retaining keys and device permissions",
    },
    run: () => manageCloud("disable"),
  }),
  reconnect: defineCommand({
    meta: { name: "reconnect", description: "Reconnect the optional outbound relay tunnel" },
    run: () => manageCloud("reconnect"),
  }),
  renew: defineCommand({
    meta: { name: "renew", description: "Retry public certificate renewal" },
    run: () => manageCloud("renew"),
  }),
};

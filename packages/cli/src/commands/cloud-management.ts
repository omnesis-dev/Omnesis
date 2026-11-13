// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { defineCommand } from "citty";
import { cloudRelayEnabled } from "@omnesis/core";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import { formatCloudStatus, trustedSignInLines, type CloudStatus } from "./cloud-status.js";

function requireCloudRelay(): void {
  if (!cloudRelayEnabled())
    throw new CliError(
      "Omnesis account commands require OMNESIS_CLOUD_RELAY_ENABLED=1",
      EXIT_USER_ERROR,
    );
}

const DONE = {
  status: "",
  configure: "Relay identity prepared.",
  enable: "Remote access is turning on.",
  disable:
    "Remote access is off. This gateway keeps its address and stays in your Omnesis account.",
  reconnect: "Reconnecting remote access.",
  renew: "Certificate renewal started. Run `omnesis cloud status` in a minute to see the result.",
  "account/unlink":
    "This gateway is unlinked from your Omnesis account. It can no longer be reached from outside your home network, and devices can no longer join by signing in. Devices already paired keep working on your home network.",
  enrollment: "",
  "trusted-sign-ins": "Trusted sign-in removed. Devices already paired keep working.",
} as const;

/**
 * All actions use the same authenticated gateway control plane as the portal.
 * Each prints what it did and the status that resulted, as text a person can
 * read and paste; `json` prints the gateway's status as it was sent.
 */
export async function manageCloud(
  action: keyof typeof DONE,
  body?: unknown,
  options: { json?: boolean; method?: "POST" | "PUT" | "DELETE"; id?: string } = {},
): Promise<void> {
  requireCloudRelay();
  const { gatewayJson } = await import("../utils.js");
  const method = options.method ?? "POST";
  const result = await gatewayJson<CloudStatus>(
    `/admin/cloud-relay${action === "status" ? "" : `/${action}`}${options.id === undefined ? "" : `/${encodeURIComponent(options.id)}`}`,
    action === "status"
      ? {}
      : { method, ...(method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }) },
  );
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  // The version is only context for someone reading the output; status never depends on it.
  const version = await gatewayJson<{ version?: unknown }>("/health")
    .then((health) => (typeof health?.version === "string" ? health.version : undefined))
    .catch(() => undefined);
  const done =
    action === "enrollment"
      ? result.deviceEnrollment?.policy === "ask"
        ? "New devices will wait for your approval."
        : "New devices join when you sign in to your Omnesis account with a sign-in this gateway trusts."
      : DONE[action];
  process.stdout.write((done ? `${done}\n\n` : "") + formatCloudStatus(result, version));
}

/** The ids `omnesis cloud remove-sign-in` takes, with what each sign-in is. */
export async function listTrustedSignIns(): Promise<void> {
  requireCloudRelay();
  const { gatewayJson } = await import("../utils.js");
  const lines = trustedSignInLines(await gatewayJson<CloudStatus>("/admin/cloud-relay"));
  process.stdout.write(
    lines.length > 0
      ? lines.join("\n") + "\n"
      : "No trusted sign-ins. New devices wait for your approval.\n",
  );
}

interface ConnectStatus {
  config?: { acmeTermsUrl?: string };
  connect?: {
    state: "idle" | "waiting" | "registering" | "linking" | "done" | "failed";
    connectUrl?: string;
    connectShortUrl?: string;
    code?: string;
    expiresAt?: number;
    error?: string;
  };
  deviceEnrollment?: { policy: "automatic" | "ask" };
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim().toLowerCase();
  } finally {
    terminal.close();
  }
}

/** One sign-in does what configure, enable and account linking otherwise do separately. */
export async function connectGateway(options: {
  acceptTerms: boolean;
  policy?: "automatic" | "ask";
}): Promise<void> {
  requireCloudRelay();
  const { gatewayJson } = await import("../utils.js");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.acceptTerms) {
    if (!interactive)
      throw new CliError(
        "Pass --accept-terms to accept the certificate provider's terms",
        EXIT_USER_ERROR,
      );
    process.stdout.write(
      "Connecting issues a public certificate for this gateway from Let's Encrypt.\nTerms: https://letsencrypt.org/repository/\n",
    );
    if (!["", "y", "yes"].includes(await ask("Accept the terms and continue? [Y/n] ")))
      throw new CliError("Connection cancelled", EXIT_USER_ERROR);
  }
  let status = (await gatewayJson("/admin/cloud-relay/connect", {
    method: "POST",
    body: JSON.stringify({ termsAccepted: true }),
  })) as ConnectStatus;
  let announced = false;
  while (status.connect && !["done", "failed", "idle"].includes(status.connect.state)) {
    if (status.connect.state === "waiting" && !announced && status.connect.connectUrl) {
      announced = true;
      process.stdout.write(
        `\nOn any device, visit ${status.connect.connectShortUrl ?? status.connect.connectUrl}\nand enter ${status.connect.code}\n\nWaiting for you to sign in to your Omnesis account…\n`,
      );
    }
    await delay(2000);
    status = (await gatewayJson("/admin/cloud-relay")) as ConnectStatus;
  }
  if (status.connect?.state !== "done")
    throw new CliError(
      `This gateway could not connect to your Omnesis account (${status.connect?.error ?? "unknown"}). Nothing changed on this gateway's existing access.`,
      EXIT_USER_ERROR,
    );
  process.stdout.write("Connected to your Omnesis account.\n");
  // Joining automatically is the gateway's default; a flag is the owner's own choice to change it.
  const current = status.deviceEnrollment?.policy;
  const policy = options.policy ?? current;
  if (!policy) return;
  if (policy !== current)
    await gatewayJson("/admin/cloud-relay/enrollment", {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
  process.stdout.write(
    policy === "automatic"
      ? "New devices join when you sign in to your Omnesis account with a sign-in this gateway trusts. You're notified of each one and can remove it.\nTo approve each new device yourself, choose Ask me first under Settings > Omnesis account in the portal.\n"
      : "New devices will wait for your approval.\n",
  );
}

export const cloudManagementCommands = {
  connect: defineCommand({
    meta: {
      name: "connect",
      description: "Connect this gateway to your Omnesis account with one sign-in",
    },
    args: {
      "accept-terms": { type: "boolean", default: false },
      "ask-first": {
        type: "boolean",
        default: false,
        description: "Require approval for each new device",
      },
      automatic: {
        type: "boolean",
        default: false,
        description: "Let new devices join when you sign in to your Omnesis account (the default)",
      },
    },
    run: ({ args }) =>
      connectGateway({
        acceptTerms: args["accept-terms"],
        ...(args["ask-first"]
          ? { policy: "ask" as const }
          : args.automatic
            ? { policy: "automatic" as const }
            : {}),
      }),
  }),
  status: defineCommand({
    meta: {
      name: "status",
      description:
        "Show the Omnesis account link and remote access: address, registration, tunnel, certificates and last errors",
    },
    args: {
      json: { type: "boolean", default: false, description: "Print the gateway's status as JSON" },
    },
    run: ({ args }) => manageCloud("status", undefined, { json: args.json }),
  }),
  unlink: defineCommand({
    meta: {
      name: "unlink",
      description:
        "Unlink this gateway from your Omnesis account. Remote access and paired devices are kept",
    },
    run: () => manageCloud("account/unlink"),
  }),
  policy: defineCommand({
    meta: {
      name: "policy",
      description: "Choose what happens when a new device signs in: automatic or ask",
    },
    args: {
      policy: { type: "positional", required: true, description: "automatic or ask" },
    },
    run: ({ args }) => {
      if (args.policy !== "automatic" && args.policy !== "ask")
        throw new CliError("The policy is automatic or ask", EXIT_USER_ERROR);
      return manageCloud("enrollment", { policy: args.policy }, { method: "PUT" });
    },
  }),
  "trusted-sign-ins": defineCommand({
    meta: {
      name: "trusted-sign-ins",
      description: "List the sign-ins that let a new device join automatically",
    },
    run: () => listTrustedSignIns(),
  }),
  "remove-sign-in": defineCommand({
    meta: {
      name: "remove-sign-in",
      description:
        "Stop trusting a sign-in, by its id from `omnesis cloud trusted-sign-ins` here or on another gateway; one this gateway doesn't trust is refused in advance",
    },
    args: { id: { type: "positional", required: true } },
    run: ({ args }) =>
      manageCloud("trusted-sign-ins", undefined, { method: "DELETE", id: args.id }),
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
      description: "Turn off remote access. Keys and device permissions are kept",
    },
    run: () => manageCloud("disable"),
  }),
  reconnect: defineCommand({
    meta: { name: "reconnect", description: "Reconnect remote access" },
    run: () => manageCloud("reconnect"),
  }),
  renew: defineCommand({
    meta: { name: "renew", description: "Retry public certificate renewal" },
    run: () => manageCloud("renew"),
  }),
};

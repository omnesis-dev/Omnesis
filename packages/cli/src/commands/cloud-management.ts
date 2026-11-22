// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { defineCommand } from "citty";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import {
  formatCloudStatus,
  dnsVerificationUrl,
  INVITE_ONLY_LINE,
  signupInviteOnly,
  trustedSignInLines,
  type CloudStatus,
} from "./cloud-status.js";

const DONE = {
  status: "",
  configure: "Relay identity prepared.",
  enable: "Remote access is turning on.",
  disable:
    "Remote access is off. This gateway keeps its address and stays in your Omnesis account.",
  reconnect: "Reconnecting remote access.",
  renew: "Certificate renewal started. Run `omnesis cloud status` in a minute to see the result.",
  "start-over":
    "The unfinished connection is discarded. This gateway is as if it had never connected: `omnesis cloud connect` starts from scratch.",
  "account/unlink":
    "This gateway is unlinked from your Omnesis account. It can no longer be reached from outside your home network, and devices can no longer join by signing in. Devices already paired keep working on your home network.",
  enrollment: "",
  "trusted-sign-ins":
    "Trusted sign-in removed. Devices already paired keep working; `--revoke-devices` also revokes the ones that joined with it.",
  "incidents/ack":
    "Certificate incident acknowledged. New devices follow your new-device setting again. An incident for another certificate puts the hold back.",
} as const;

/** What removing a sign-in with `--revoke-devices` did to the devices that joined with it. */
function revokedDevicesLine(count: number): string {
  if (count === 0) return "Trusted sign-in removed. No paired device had joined with it.";
  return `Trusted sign-in removed. ${count === 1 ? "1 device that joined with it was" : `${count} devices that joined with it were`} revoked.`;
}

/**
 * All actions use the same authenticated gateway control plane as the portal.
 * Each prints what it did and the status that resulted, as text a person can
 * read and paste; `json` prints the gateway's status as it was sent.
 */
export async function manageCloud(
  action: keyof typeof DONE,
  body?: unknown,
  options: {
    json?: boolean;
    method?: "POST" | "PUT" | "DELETE";
    id?: string;
    query?: Record<string, string>;
  } = {},
): Promise<void> {
  const { gatewayJson } = await import("../utils.js");
  const method = options.method ?? "POST";
  // Status shows how to sign up, so it lets the gateway ask the relay whether accounts are
  // invite-only; no other read reaches the relay.
  const params = action === "status" ? { ...options.query, signup: "1" } : options.query;
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const result = await gatewayJson<CloudStatus & { revokedDevices?: unknown }>(
    `/admin/cloud-relay${action === "status" ? "" : `/${action}`}${options.id === undefined ? "" : `/${encodeURIComponent(options.id)}`}${query}`,
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
      : Array.isArray(result.revokedDevices)
        ? revokedDevicesLine(result.revokedDevices.length)
        : DONE[action];
  process.stdout.write((done ? `${done}\n\n` : "") + formatCloudStatus(result, version));
}

/** The ids `omnesis cloud remove-sign-in` takes, with what each sign-in is. */
export async function listTrustedSignIns(): Promise<void> {
  const { gatewayJson } = await import("../utils.js");
  const lines = trustedSignInLines(await gatewayJson<CloudStatus>("/admin/cloud-relay"));
  process.stdout.write(
    lines.length > 0
      ? lines.join("\n") + "\n"
      : "No sign-ins on your account are recorded here. New devices wait for your approval.\n",
  );
}

interface ConnectStatus {
  config?: { acmeTermsUrl?: string };
  account?: { linked?: boolean };
  publicOrigin?: string;
  publicMcp?: { url?: string };
  connect?: {
    state: "idle" | "waiting" | "registering" | "linking" | "done" | "failed";
    step?: "registering" | "certificate" | "tunnel";
    verification?: { url: string; expiresAt: number };
    connectUrl?: string;
    connectShortUrl?: string;
    code?: string;
    expiresAt?: number;
    error?: string;
    existingAccount?: boolean;
  };
  deviceEnrollment?: { policy: "automatic" | "ask" };
  signup?: CloudStatus["signup"];
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim().toLowerCase();
  } finally {
    terminal.close();
  }
}

const ALREADY_LINKED =
  "This gateway is already connected to an Omnesis account. To connect it to another, run `omnesis cloud unlink` first.";
const CHOOSE_ACCOUNT =
  "Choose how to connect: pass --existing to sign in to an Omnesis account you already have, or --invite '<link>' to create one with the invite link you were sent.";
const EXISTING_ACCOUNT =
  "You already had an Omnesis account, so this gateway is now linked to it. Your invite wasn't used.";

/** The one line on the certificate authority's terms, when the gateway names them. */
export function termsLine(status: { config?: { acmeTermsUrl?: string } }): string | undefined {
  const url = httpsAddress(status.config?.acmeTermsUrl);
  return url
    ? `By connecting, you agree to Let's Encrypt's Subscriber Agreement: ${url}`
    : undefined;
}

/** A printable HTTPS address from the gateway's status, or undefined. */
function httpsAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[^\x21-\x7e]/.test(value))
    return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The line for the step the gateway is on now, or undefined when it has none of its own. Steps
 * an older gateway doesn't name are announced once, by their state.
 */
function progressLine(
  status: ConnectStatus,
  letsEncrypt: boolean,
): [key: string, line: string] | undefined {
  const connect = status.connect;
  if (connect?.state === "registering") {
    if (connect.step === "certificate")
      return [
        "certificate",
        letsEncrypt
          ? "Getting this gateway's certificate from Let's Encrypt. This usually takes under a minute…"
          : "Getting this gateway's certificate. This usually takes under a minute…",
      ];
    if (connect.step === "tunnel") return ["tunnel", "Opening the connection…"];
    return ["registering", "Registering this gateway with the Omnesis relay…"];
  }
  if (connect?.state === "linking")
    return ["linking", "Linking this gateway to your Omnesis account…"];
  return undefined;
}

/**
 * One sign-in does what configure, enable and account linking otherwise do separately. Every
 * question has a flag, so a script runs it unattended: `existing` signs in to an account the
 * owner has, `invite` creates one with it. Connecting accepts the certificate terms it prints.
 */
export async function connectGateway(options: {
  policy?: "automatic" | "ask";
  /** An invite link or code: the person is creating a new Omnesis account with it. */
  invite?: string;
  /** The person signs in to an Omnesis account they already have. */
  existing?: boolean;
}): Promise<void> {
  const { gatewayJson } = await import("../utils.js");
  if (options.invite && options.existing)
    throw new CliError(
      "Pass --existing or --invite, not both: an invite only creates a new account.",
      EXIT_USER_ERROR,
    );
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.invite && !options.existing && !interactive)
    throw new CliError(CHOOSE_ACCOUNT, EXIT_USER_ERROR);
  const read = () => gatewayJson<ConnectStatus>("/admin/cloud-relay?signup=1");
  let status = await read();
  if (status.account?.linked) throw new CliError(ALREADY_LINKED, EXIT_USER_ERROR);
  let intent: "create" | "existing" = options.invite ? "create" : "existing";
  if (!options.invite && !options.existing) {
    const answer = await ask("Do you already have an Omnesis account? [y/N] ");
    if (!["y", "yes"].includes(answer)) {
      // The gateway has had the time the question took to learn whether accounts need an invite.
      status = await read();
      if (signupInviteOnly(status)) throw new CliError(INVITE_ONLY_LINE, EXIT_USER_ERROR);
      intent = "create";
    }
  }
  const terms = termsLine(status);
  if (terms) process.stdout.write(`${terms}\n`);
  try {
    status = (await gatewayJson("/admin/cloud-relay/connect", {
      method: "POST",
      body: JSON.stringify({
        termsAccepted: true,
        intent,
        ...(options.invite ? { invite: options.invite } : {}),
      }),
    })) as ConnectStatus;
  } catch (error) {
    // The gateway checks the invite with the relay before anything else, and names a refusal.
    const refusal = Object.keys(INVITE_ERRORS).find((code) => String(error).includes(code));
    if (refusal) throw new CliError(INVITE_ERRORS[refusal]!.trim(), EXIT_USER_ERROR);
    if (String(error).includes("already-connected"))
      throw new CliError(ALREADY_LINKED, EXIT_USER_ERROR);
    throw error;
  }
  let announced = false;
  let signedIn = false;
  let verificationAnnounced: string | undefined;
  let step: string | undefined;
  // The gateway learns from its relay whether new accounts need an invite; said once, when it knows.
  let inviteOnlyShown = Boolean(options.invite) || intent === "existing";
  while (status.connect && !["done", "failed", "idle"].includes(status.connect.state)) {
    if (status.connect.verification) {
      const url = dnsVerificationUrl(status.connect.verification.url);
      if (!url)
        throw new CliError("The gateway's security check link was refused", EXIT_USER_ERROR);
      if (url !== verificationAnnounced) {
        verificationAnnounced = url;
        process.stdout.write(
          `\nOpen ${url}\nto complete this gateway's security check. Cloudflare may ask you to confirm you're human. No approval from Omnesis is needed.\n\nWaiting for the security check…\n`,
        );
      }
    }
    if (status.connect.state === "waiting" && !announced && status.connect.connectUrl) {
      announced = true;
      process.stdout.write(
        `\nOn any device, visit ${status.connect.connectShortUrl ?? status.connect.connectUrl}\nand enter ${status.connect.code}\n\n${intent === "create" ? "Waiting for you to create your Omnesis account…" : "Waiting for you to sign in to your Omnesis account…"}\n`,
      );
    }
    if (status.connect.state !== "waiting" && !signedIn) {
      signedIn = true;
      process.stdout.write("Signed in.\n");
    }
    const progress = progressLine(status, Boolean(terms));
    if (progress && progress[0] !== step) {
      step = progress[0];
      process.stdout.write(`${progress[1]}\n`);
    }
    if (!inviteOnlyShown && signupInviteOnly(status)) {
      inviteOnlyShown = true;
      process.stdout.write(`${INVITE_ONLY_LINE}\n`);
    }
    await delay(2000);
    status = await read();
  }
  if (status.connect?.state !== "done") {
    const error = status.connect?.error;
    throw new CliError(
      `This gateway could not connect to your Omnesis account (${error ?? "unknown"}). Nothing changed on this gateway's existing access.${error ? (INVITE_ERRORS[error] ?? "") : ""}`,
      EXIT_USER_ERROR,
    );
  }
  // A sign-in that finished between two looks still says it was seen.
  if (announced && !signedIn) process.stdout.write("Signed in.\n");
  process.stdout.write("Connected to your Omnesis account.\n");
  if (status.connect.existingAccount) {
    process.stdout.write(`${EXISTING_ACCOUNT}\n`);
    // Said here, so the portal doesn't say it again. Failing to record that changes nothing else.
    await gatewayJson("/admin/cloud-relay/connect/acknowledge", {
      method: "POST",
      body: "{}",
    }).catch(() => undefined);
  }
  const origin = httpsAddress(status.publicOrigin);
  if (origin) {
    const mcp = httpsAddress(status.publicMcp?.url) ?? new URL("/mcp", origin).href;
    process.stdout.write(
      `\n  Address: ${origin.replace(/\/$/, "")}\n  Portal:  ${new URL("/portal/", origin).href}\n  MCP:     ${mcp}\n\n`,
    );
  }
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
      ? "New devices join when you sign in to your Omnesis account with a sign-in this gateway trusts. You're notified of each one and can remove it.\nTo approve each new device yourself, choose Ask me first under Settings > Connectivity, New devices in the portal.\n"
      : "New devices will wait for your approval.\n",
  );
}

const START_OVER_REFUSED =
  "This gateway has connected to the Omnesis relay, so there is no unfinished connection to discard. To leave your Omnesis account, run `omnesis cloud unlink`.";

/** Discards a connection that never finished, then prints the status that resulted. */
export async function startOver(): Promise<void> {
  try {
    await manageCloud("start-over");
  } catch (error) {
    if (String(error).includes("already-connected"))
      throw new CliError(START_OVER_REFUSED, EXIT_USER_ERROR);
    throw error;
  }
}

const INVITE_ERRORS: Record<string, string> = {
  "invite-invalid": " The invite isn't valid: check that you copied the whole link.",
  "invite-expired": " The invite has expired: ask for a new one.",
  "invite-used": " The invite was already used to create an account: ask for a new one.",
};

export const cloudManagementCommands = {
  connect: defineCommand({
    meta: {
      name: "connect",
      description:
        "Connect this gateway to your Omnesis account with one sign-in. Without a terminal, pass --existing or --invite",
    },
    args: {
      existing: {
        type: "boolean",
        default: false,
        description: "Sign in to an Omnesis account you already have, without asking",
      },
      invite: {
        type: "string",
        description: "The invite link you were sent, to create a new Omnesis account",
      },
      "accept-terms": {
        type: "boolean",
        default: false,
        description: "Accepted by connecting; kept so existing scripts keep working",
      },
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
        ...(args.invite ? { invite: args.invite } : {}),
        ...(args.existing ? { existing: true } : {}),
        ...(args["ask-first"]
          ? { policy: "ask" as const }
          : args.automatic
            ? { policy: "automatic" as const }
            : {}),
      }),
  }),
  "start-over": defineCommand({
    meta: {
      name: "start-over",
      description:
        "Discard a connection that never finished: its reserved address, gateway ID and keys. Refused once the gateway has connected",
    },
    run: () => startOver(),
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
        "Unlink this gateway from your Omnesis account. Paired devices keep working on your home network",
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
    args: {
      id: { type: "positional", required: true },
      "revoke-devices": {
        type: "boolean",
        default: false,
        description: "Also revoke every paired device that joined with this sign-in",
      },
    },
    run: ({ args }) =>
      manageCloud("trusted-sign-ins", undefined, {
        method: "DELETE",
        id: args.id,
        ...(args["revoke-devices"] ? { query: { revokeDevices: "true" } } : {}),
      }),
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

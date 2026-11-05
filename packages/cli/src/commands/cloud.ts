// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { experimentalEnabled } from "@omnesis/core";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import { z } from "zod";
import { cloudManagementCommands } from "./cloud-management.js";
import { cloudRecoveryCommands } from "./cloud-recovery.js";

function requireExperimental(): void {
  if (!experimentalEnabled())
    throw new CliError("Cloud pairing requires OMNESIS_EXPERIMENTAL=1", EXIT_USER_ERROR);
}

type CloudIdentityOperation =
  | "google-login"
  | "register-gateway"
  | "pair-device"
  | "register-key"
  | "issue-invite"
  | "link-google"
  | "unlink-google"
  | "prepare-owner";
const success: Record<CloudIdentityOperation, string> = {
  "prepare-owner": "",
  "google-login": "Google routing identity saved.",
  "register-gateway": "Google gateway identity saved.",
  "pair-device": "Gateway key verified; device credential saved.",
  "register-key": "Gateway owner identity registered; keep its private owner-key file backed up.",
  "issue-invite": "Gateway enrollment invitation saved privately.",
  "link-google":
    "Google discovery linked. Restart the gateway with its Google pairing configuration to enable sign-in.",
  "unlink-google":
    "Google discovery link removed. Existing device permissions remain controlled by the gateway.",
};

export async function runCloudIdentityCommand(
  command: CloudIdentityOperation,
  options: { kind?: string; name?: string } = {},
): Promise<void> {
  requireExperimental();
  try {
    const { runRelayCommand } = await import("@omnesis/cloud-relay/runtime");
    const env =
      options.kind !== undefined || options.name !== undefined
        ? {
            ...process.env,
            ...(options.kind === undefined
              ? {}
              : {
                  OMNESIS_CLOUD_RELAY_DEVICE_KIND: z.enum(["cli", "collector"]).parse(options.kind),
                }),
            ...(options.name === undefined
              ? {}
              : {
                  OMNESIS_CLOUD_RELAY_DEVICE_NAME: z
                    .string()
                    .trim()
                    .min(1)
                    .max(80)
                    .parse(options.name),
                }),
          }
        : process.env;
    await runRelayCommand(command, env);
    if (success[command]) process.stdout.write(success[command] + "\n");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "GOOGLE_DESKTOP_UNAVAILABLE")
        throw new CliError(
          "Google sign-in is unavailable in this installation; ask its administrator to configure the desktop OAuth client, or use QR/manual pairing",
          EXIT_USER_ERROR,
        );
      if (error.code === "CLOUD_CLIENT_TOKEN_COLLISION")
        throw new CliError(
          "An existing device credential would be replaced; use a separate OMNESIS_CONFIG_DIR for this pairing",
          EXIT_USER_ERROR,
        );
    }
    throw new CliError(
      "Cloud registration or pairing failed; check the relay, invitation, OAuth and private key configuration.",
      EXIT_USER_ERROR,
    );
  }
}

/** Run against the gateway's local endpoint or an independently pinned client adapter. */
export async function decideCloudPairing(
  action: "list" | "approve" | "deny",
  id?: string,
  code?: string,
): Promise<void> {
  requireExperimental();
  const { gatewayJson } = await import("../utils.js");
  if (action === "list" || action === "approve") {
    const result = z
      .object({
        items: z.array(
          z.object({
            requestId: z.string().uuid(),
            name: z.string(),
            kind: z.string(),
            status: z.string(),
            verificationCode: z.string().regex(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/),
            expiresAt: z.number().int(),
          }),
        ),
      })
      .parse(await gatewayJson("/admin/cloud-pairing/requests"));
    if (action === "list") {
      for (const row of result.items)
        process.stdout.write(
          `${row.requestId} ${JSON.stringify(row.name)} ${row.kind} ${row.status} ${row.verificationCode}\n`,
        );
      return;
    }
    const row = result.items.find((request) => request.requestId === id);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now())
      throw new CliError("No current pending pairing request matches this ID", EXIT_USER_ERROR);
    if (row.verificationCode !== code?.trim().toUpperCase())
      throw new CliError(
        "The code does not match the requesting device; pairing refused",
        EXIT_USER_ERROR,
      );
  }
  const requestId = z.string().uuid().parse(id);
  await gatewayJson("/admin/cloud-pairing/decision", {
    method: "POST",
    body: JSON.stringify({ requestId, approve: action === "approve" }),
  });
  process.stdout.write(
    action === "approve" ? "Device pairing approved.\n" : "Device pairing denied.\n",
  );
}

export const cloudCommand = defineCommand({
  meta: { name: "cloud", description: "Experimental encrypted relay identity and device pairing" },
  subCommands: {
    ...cloudManagementCommands,
    ...cloudRecoveryCommands,
    login: defineCommand({
      meta: { name: "login", description: "Sign in to Google for relay discovery" },
      run: () => runCloudIdentityCommand("google-login"),
    }),
    register: defineCommand({
      meta: { name: "register", description: "Register this gateway's public TLS identity" },
      run: () => runCloudIdentityCommand("register-gateway"),
    }),
    "prepare-owner": defineCommand({
      meta: {
        name: "prepare-owner",
        description: "Prepare private ownership and print public enrollment metadata",
      },
      run: () => runCloudIdentityCommand("prepare-owner"),
    }),
    "register-key": defineCommand({
      meta: {
        name: "register-key",
        description: "Register this gateway with its own keys, without Google",
      },
      run: () => runCloudIdentityCommand("register-key"),
    }),
    "issue-invite": defineCommand({
      meta: {
        name: "issue-invite",
        description: "Create a private invitation for one gateway on this relay",
      },
      run: () => runCloudIdentityCommand("issue-invite"),
    }),
    "link-google": defineCommand({
      meta: {
        name: "link-google",
        description: "Optionally link Google discovery to a key-owned gateway",
      },
      run: () => runCloudIdentityCommand("link-google"),
    }),
    "unlink-google": defineCommand({
      meta: {
        name: "unlink-google",
        description: "Remove Google discovery without replacing gateway keys",
      },
      run: () => runCloudIdentityCommand("unlink-google"),
    }),
    pair: defineCommand({
      meta: {
        name: "pair",
        description:
          "Find and pair a CLI or collector using Google and a trusted-device comparison",
      },
      args: {
        kind: { type: "string", description: "Device type: cli or collector" },
        name: { type: "string", description: "Device name shown for approval" },
      },
      run: ({ args }) =>
        runCloudIdentityCommand("pair-device", { kind: args.kind, name: args.name }),
    }),
    requests: defineCommand({
      meta: {
        name: "requests",
        description: "Show pending device comparison codes on this trusted gateway",
      },
      run: () => decideCloudPairing("list"),
    }),
    approve: defineCommand({
      meta: { name: "approve", description: "Approve a device after matching its displayed code" },
      args: {
        id: { type: "positional", required: true },
        code: {
          type: "string",
          required: true,
          description: "Comparison code displayed by the requesting device",
        },
      },
      run: ({ args }) => decideCloudPairing("approve", args.id, args.code),
    }),
    deny: defineCommand({
      meta: { name: "deny", description: "Deny a pending device pairing request" },
      args: { id: { type: "positional", required: true } },
      run: ({ args }) => decideCloudPairing("deny", args.id),
    }),
  },
});

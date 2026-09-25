// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { tryScope, type Scope } from "@omnesis/types";
import { parseDuration } from "@omnesis/core";
import {
  c,
  formatTimeAgoMs,
  gatewayFetch,
  gatewayJson,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
  GATEWAY_REQUEST_URL,
} from "../utils.js";

interface ListedToken {
  id: string;
  deviceId: string;
  scopes: Scope[];
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

const fmtTime = (ms: number | null): string => formatTimeAgoMs(ms, { longFormat: "iso-date" });

const tokensListCommand = defineCommand({
  meta: { name: "list", description: "List issued auth tokens" },
  async run() {
    const { items: tokens } = await withSpinner("Loading tokens", () =>
      gatewayJson<{ items: ListedToken[] }>("/admin/tokens"),
    );
    if (tokens.length === 0) {
      console.log("No tokens.");
      return;
    }
    console.log();
    console.log(
      `${c.bold}${"NAME".padEnd(20)} ${"DEVICE".padEnd(38)} ${"SCOPES".padEnd(40)} CREATED  LAST USED${c.reset}`,
    );
    for (const t of tokens) {
      console.log(
        `${(t.name ?? "—").padEnd(20)} ${t.deviceId.padEnd(38)} ${t.scopes.join(",").padEnd(40)} ${fmtTime(t.createdAt)}  ${fmtTime(t.lastUsedAt)}`,
      );
    }
    console.log();
  },
});

const tokensCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a new scoped auth token for a device" },
  args: {
    device: {
      type: "string",
      description: "Device id or name to issue the token for",
    },
    scopes: {
      type: "string",
      description: "Comma-separated scopes (answer, read, admin, write:*, write:<source-type>)",
    },
    name: {
      type: "string",
      description: "Optional label for the token",
    },
    ttl: {
      type: "string",
      description: 'Optional expiry, e.g. "1h", "7d", "30d". Omit for a token that never expires.',
    },
  },
  async run(ctx) {
    // Each prompt is gated on the matching --flag: when the flag is
    // supplied, the prompt is skipped, so the command runs
    // non-interactively when fully specified.
    const prompts = await import("@clack/prompts");
    const { items: devices } = await withSpinner("Loading devices", () =>
      gatewayJson<{ items: { id: string; name: string; kind: string }[] }>("/admin/devices"),
    );
    if (devices.length === 0) {
      throw new CliError(
        `${c.red}No devices yet — pair one first with 'omnesis devices pair'.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const deviceFlag = typeof ctx.args.device === "string" ? ctx.args.device : undefined;
    let deviceId: string;
    if (deviceFlag !== undefined) {
      const match = devices.find((d) => d.id === deviceFlag || d.name === deviceFlag);
      if (!match) {
        throw new CliError(
          `${c.red}No device matching '${deviceFlag}'. Run 'omnesis devices list' to see ids.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      deviceId = match.id;
    } else {
      const picked = (await prompts.select({
        message: "Device to issue the token for",
        options: devices.map((d) => ({ value: d.id, label: `${d.name} (${d.kind})` })),
      })) as string;
      if (prompts.isCancel(picked)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      deviceId = picked;
    }

    const scopesFlag = typeof ctx.args.scopes === "string" ? ctx.args.scopes : undefined;
    let scopeStr: string;
    if (scopesFlag !== undefined) {
      scopeStr = scopesFlag;
    } else {
      const prompted = (await prompts.text({
        message: "Comma-separated scopes (answer, read, admin, write:*, write:<type>)",
        initialValue: "read",
      })) as string;
      if (prompts.isCancel(prompted)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      scopeStr = prompted;
    }
    // Per-token validation: bad scope strings surface as a typed user
    // error rather than minting a token whose scopes the gateway
    // would silently filter on read.
    const scopes: Scope[] = [];
    for (const raw of scopeStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const sc = tryScope(raw);
      if (!sc) {
        throw new CliError(`${c.red}Invalid scope: ${raw}${c.reset}`, EXIT_USER_ERROR);
      }
      scopes.push(sc);
    }

    const nameFlag = typeof ctx.args.name === "string" ? ctx.args.name : undefined;
    let name: string;
    if (nameFlag !== undefined) {
      name = nameFlag;
    } else {
      name = (await prompts.text({ message: "Optional label", initialValue: "" })) as string;
    }

    // --ttl is flag-only (no prompt): the default is a never-expiring token,
    // which is what most callers want. Parse the duration here so a typo is a
    // typed user error, not a confusing 400 from the gateway.
    const ttlFlag = typeof ctx.args.ttl === "string" && ctx.args.ttl ? ctx.args.ttl : undefined;
    let ttlMs: number | undefined;
    if (ttlFlag !== undefined) {
      try {
        ttlMs = parseDuration(ttlFlag);
      } catch (err) {
        throw new CliError(
          `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
    }

    const res = await withSpinner("Creating token", () =>
      gatewayFetch("/admin/tokens", {
        method: "POST",
        body: JSON.stringify({ deviceId, scopes, name: name || undefined, ttlMs }),
      }),
    );
    if (!res.ok) {
      throw new CliError(
        `${c.red}Could not create the token: ${await gatewayRefusal(res)}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    const result = (await res.json()) as { id: string; token: string; expiresAt: number | null };
    console.log();
    console.log(`${c.bold}Token created.${c.reset}`);
    console.log(`  ID:    ${result.id}`);
    console.log(`  Token: ${c.cyan}${result.token}${c.reset}`);
    console.log(
      `  Expires: ${result.expiresAt === null ? `${c.dim}never${c.reset}` : new Date(result.expiresAt).toISOString()}`,
    );
    console.log(`${c.dim}Save this token — it cannot be retrieved again.${c.reset}`);
    console.log();
  },
});

/**
 * What the gateway said when it refused: its own sentence when the body
 * carries one, otherwise the status and whatever text came back.
 */
export async function gatewayRefusal(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  } catch {
    /* not JSON: fall through to the raw text */
  }
  return `gateway ${res.status}${text ? `: ${text}` : ""}`;
}

const tokensRevokeCommand = defineCommand({
  meta: { name: "revoke", description: "Revoke an auth token by id" },
  args: {
    id: {
      type: "positional",
      description: "token id",
      required: true,
    },
  },
  async run(ctx) {
    const target = ctx.args.id;
    if (!target) {
      throw new CliError(
        `${c.red}Usage: omnesis tokens revoke <token-id>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const { resolveToken } = await import("@omnesis/core");
    const token = resolveToken();
    if (!token) {
      throw new CliError(`${c.red}No auth token found.${c.reset}`, EXIT_AUTH);
    }
    const res = await withSpinner(`Revoking token ${target}`, () =>
      fetch(`${GATEWAY_REQUEST_URL}/admin/tokens/${target}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    if (!res.ok) {
      throw new CliError(
        `${c.red}Failed: ${res.status} ${await res.text()}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    console.log(`Revoked token ${target}.`);
  },
});

export const tokensCommand = defineCommand({
  meta: {
    name: "tokens",
    description: "Manage scoped auth tokens",
  },
  subCommands: {
    list: tokensListCommand,
    create: tokensCreateCommand,
    revoke: tokensRevokeCommand,
  },
  // Default to `list` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(tokensListCommand, { rawArgs: [] });
    }
  },
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayJson,
  withSpinner,
  CliError,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
} from "../utils.js";
import {
  fetchCredentialsStatus,
  isSameHostAsCollector,
  resolveCredentialsEntry,
  runCredentialsWizard,
} from "../credentials-wizard.js";

/**
 * `cli creds` — manage provider OAuth credentials.
 *
 *   cli creds [list]            list per-provider status
 *   cli creds set <provider>    run the setup wizard
 *   cli creds clear <provider>  remove the saved credentials file
 */
const credsListCommand = defineCommand({
  meta: { name: "list", description: "List per-provider credentials status" },
  async run() {
    const status = await withSpinner("Loading credentials", () => fetchCredentialsStatus());
    if (status.items.length === 0) {
      console.log(`${c.dim}No providers declare credentials specs.${c.reset}`);
      return;
    }
    console.log(`\n${c.bold}Provider credentials${c.reset}\n`);
    for (const entry of status.items) {
      const dot = entry.configured
        ? `${c.green}●${c.reset}`
        : entry.spec.required
          ? `${c.red}○${c.reset}`
          : `${c.dim}○${c.reset}`;
      const tag = entry.configured
        ? "user-configured"
        : entry.spec.publicClient
          ? "using bundled public client"
          : "missing";
      const reqLabel =
        entry.spec.required && !entry.configured ? `${c.red} (required)${c.reset}` : "";
      console.log(`  ${dot} ${entry.providerName.padEnd(12)} ${c.dim}${tag}${c.reset}${reqLabel}`);
      console.log(
        `     ${c.dim}fileKey: ${entry.spec.fileKey}, file: ~/.config/omnesis/${entry.spec.fileKey}-credentials.json${c.reset}`,
      );
    }
    console.log();
    console.log(
      `${c.dim}Run \`cli creds set <provider>\` to configure or update credentials.${c.reset}`,
    );
  },
});

const credsSetCommand = defineCommand({
  meta: { name: "set", description: "Run the credentials setup wizard for a provider" },
  args: {
    provider: {
      type: "positional",
      description: "provider type or fileKey (e.g. google)",
      required: true,
    },
  },
  async run(ctx) {
    const target = ctx.args.provider;
    if (!target) {
      throw new CliError(
        `${c.red}Usage: cli creds set <provider>${c.reset}\n` +
          `${c.dim}E.g. cli creds set google${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const status = await withSpinner("Loading credentials", () => fetchCredentialsStatus());
    const entry = resolveCredentialsEntry(target, status.items);
    if (!entry) throw new CliError("", EXIT_USER_ERROR);

    const sameHost = isSameHostAsCollector(status.hostname);
    const ok = await runCredentialsWizard(entry, { deviceId: status.deviceId, sameHost });
    if (!ok) throw new CliError("", EXIT_FAILURE);
  },
});

const credsClearCommand = defineCommand({
  meta: { name: "clear", description: "Remove the saved credentials file for a provider" },
  args: {
    provider: {
      type: "positional",
      description: "provider type or fileKey (e.g. google)",
      required: true,
    },
  },
  async run(ctx) {
    const target = ctx.args.provider;
    if (!target) {
      throw new CliError(`${c.red}Usage: cli creds clear <provider>${c.reset}`, EXIT_USER_ERROR);
    }
    const prompts = await import("@clack/prompts");
    const status = await withSpinner("Loading credentials", () => fetchCredentialsStatus());
    const entry = resolveCredentialsEntry(target, status.items);
    if (!entry) throw new CliError("", EXIT_USER_ERROR);

    if (!entry.configured) {
      console.log(
        `${c.dim}${entry.providerName} has no saved credentials — nothing to clear.${c.reset}`,
      );
      return;
    }

    const confirm = await prompts.confirm({
      message: `Clear saved ${entry.providerName} credentials?`,
      initialValue: false,
    });
    if (prompts.isCancel(confirm) || !confirm) {
      prompts.cancel("Cancelled.");
      throw new CliError("", EXIT_CANCELLED);
    }

    await withSpinner(`Clearing ${entry.providerName} credentials`, () =>
      gatewayJson(
        `/admin/credentials/${encodeURIComponent(entry.spec.fileKey)}?deviceId=${encodeURIComponent(status.deviceId)}`,
        { method: "DELETE" },
      ),
    );

    if (entry.spec.required) {
      console.log(
        `\n${c.yellow}${entry.providerName} credentials cleared.${c.reset} ${c.dim}This provider requires user-supplied credentials — sources under it will fail to authenticate until you run \`cli creds set ${entry.spec.fileKey}\`.${c.reset}`,
      );
    } else if (entry.spec.publicClient) {
      console.log(
        `\n${c.green}${entry.providerName} credentials cleared.${c.reset} ${c.dim}Falling back to Omnesis's bundled public client.${c.reset}`,
      );
    } else {
      console.log(`\n${c.green}${entry.providerName} credentials cleared.${c.reset}`);
    }
  },
});

export const credsCommand = defineCommand({
  meta: {
    name: "creds",
    description: "Manage provider OAuth credentials",
  },
  subCommands: {
    list: credsListCommand,
    set: credsSetCommand,
    clear: credsClearCommand,
  },
  // Default to `list` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(credsListCommand, { rawArgs: [] });
    }
  },
});

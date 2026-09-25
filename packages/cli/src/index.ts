#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export {};

// Load $OMNESIS_CONFIG_DIR/.env before ./utils.js freezes GATEWAY_URL. See #52.
import "./load-env.js";
import { defineCommand, runCommand, showUsage, type CommandDef, type SubCommandsDef } from "citty";
import { runCli } from "@omnesis/cli-shared";
import { ensureGatewayTrust, readPackageVersion, DEFAULT_CONFIG_DIR } from "@omnesis/core";
import { GATEWAY_REQUEST_URL } from "./utils.js";
import { isDefaultGatewayTrustExempt } from "./trust-preflight.js";
import { SUB_COMMANDS, visibleSubCommands } from "./subcommands.js";
import { assertKnownFlags } from "./unknown-flags.js";
import { installUpdateSignalHandlers, updateInterruptionRouter } from "./update/interruption.js";

const CLI_VERSION = readPackageVersion(import.meta.url);

/**
 * Citty entrypoint. Each leaf is a `defineCommand` exported from its file
 * under `commands/` and pulled in lazily — running `omnesis search foo`
 * shouldn't import @clack/prompts, qrcode-terminal, or any other admin-only
 * dep tree, so commands resolve via a per-key dynamic import.
 */
const main = defineCommand({
  meta: {
    name: "omnesis",
    version: CLI_VERSION,
    description: "Index and search your entire digital life. Fully local, fully private.",
  },
  subCommands: SUB_COMMANDS,
});

/** `main` with the hidden aliases stripped, for rendering the top-level help. */
const mainForHelp: CommandDef = { ...main, subCommands: visibleSubCommands() };

const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

// Daemon subcommands host long-lived processes that register their own
// SIGINT/SIGTERM graceful-shutdown handlers — runCli's default
// exit(130)-on-SIGINT would preempt them, so it's disabled for these.
const isDaemonInvocation = rawArgs[0] === "gateway" || rawArgs[0] === "collector";
const isUpdateInvocation = rawArgs[0] === "update";

// Commands that never call the default gateway (or do so only best-effort)
// must work without its TOFU preflight: lifecycle commands run in installers
// and CI where stdin is not a TTY, while `connect` selects and trusts its own
// target. Daemons own their trust story: `gateway serve` IS the gateway, and
// `collector run` runs the collector's own flow (with the mDNS fingerprint
// pre-seed).
const isLocalInvocation = isDefaultGatewayTrustExempt(rawArgs);

// TOFU: trust the gateway's self-signed cert before any network call.
const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
if (!isDaemonInvocation && !isLocalInvocation) {
  try {
    const tofu = await ensureGatewayTrust({
      gatewayUrl: GATEWAY_REQUEST_URL,
      configDir,
      verifyServed: true,
    });
    if (tofu.action === "insecure-mode") {
      process.stderr.write(
        "Warning: OMNESIS_INSECURE_TLS is set — TLS certificate verification disabled\n",
      );
    }
  } catch (err) {
    process.stderr.write(`TLS trust failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}

const removeUpdateSignalHandlers = isUpdateInvocation
  ? installUpdateSignalHandlers(updateInterruptionRouter)
  : () => {};

let exitCode: number;
try {
  exitCode = await runCli(
    async () => {
      if (
        rawArgs.length === 0 ||
        rawArgs[0] === "help" ||
        rawArgs.includes("--help") ||
        rawArgs.includes("-h")
      ) {
        const target = await resolveSubcommandForHelp(main, rawArgs);
        await showUsage(target === main ? mainForHelp : target);
        return;
      }
      // After help and before the parser: an unrecognised flag is a usage error,
      // not something to run the command in spite of. Placed here so `-h`
      // anywhere still prints usage rather than being refused as a stray flag.
      await assertKnownFlags(main, rawArgs);
      if (rawArgs[0] === "--version" || rawArgs[0] === "-V") {
        console.log(CLI_VERSION);
        // Best-effort version reconciliation against the running gateway —
        // CLI and gateway version independently across machines, so flag a
        // mismatch the way Ollama does. Silent on any failure: `--version`
        // must work with no gateway running.
        try {
          const res = await fetch(`${GATEWAY_REQUEST_URL}/health`, {
            signal: AbortSignal.timeout(300),
          });
          const body = (await res.json()) as { version?: string };
          if (body.version && body.version !== CLI_VERSION) {
            process.stderr.write(
              `Warning: gateway at ${GATEWAY_REQUEST_URL} is version ${body.version} (CLI is ${CLI_VERSION})\n`,
            );
          }
        } catch {
          // No reachable gateway — nothing to reconcile.
        }
        return;
      }
      await runCommand(main, { rawArgs });
    },
    {
      gatewayDownHint: `Cannot reach gateway at ${GATEWAY_REQUEST_URL}. Is it running?`,
      ...(isDaemonInvocation || isUpdateInvocation ? { onSigint: () => {} } : {}),
    },
  );
} finally {
  removeUpdateSignalHandlers();
}
// process.exit() tears the process down before piped stdio drains, which
// truncates output beyond the ~64 KiB kernel pipe buffer (e.g. a large
// `analytics --json` payload captured by a test or shell pipeline). An
// empty write's callback fires only after everything buffered before it
// has flushed, so awaiting it makes the explicit exit safe. The explicit
// exit itself stays: open handles (gateway WS, keep-alive sockets) would
// otherwise keep the process alive.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => resolve());
});
process.exit(exitCode);

/**
 * Walk the subcommand tree following the user's leading positional tokens
 * until the next token is a flag or doesn't match any registered subcommand.
 * Returns the deepest matched command — that's the one whose usage we want
 * to print on `--help`. Mirrors what citty's `runMain` does internally,
 * kept here so the help path doesn't go through citty's own
 * `process.exit(0)`.
 */
async function resolveSubcommandForHelp(cmd: CommandDef, argsArr: string[]): Promise<CommandDef> {
  let current: CommandDef = cmd;
  for (const tok of argsArr) {
    if (tok === "--help" || tok === "-h" || tok === "help") break;
    if (tok.startsWith("-")) break;
    const subs =
      typeof current.subCommands === "function"
        ? await (current.subCommands as () => Promise<SubCommandsDef>)()
        : ((await current.subCommands) as SubCommandsDef | undefined);
    if (!subs) break;
    const next = subs[tok];
    if (!next) break;
    current = (typeof next === "function" ? await next() : await next) as CommandDef;
  }
  return current;
}

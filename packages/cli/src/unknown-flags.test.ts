// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { defineCommand } from "citty";
import { describe, expect, it } from "vitest";

import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import { SUB_COMMANDS } from "./subcommands.js";
import { assertKnownFlags } from "./unknown-flags.js";

/** The real command tree, so a command whose flags change is checked here too. */
const main = defineCommand({ meta: { name: "omnesis" }, subCommands: SUB_COMMANDS });

async function refusalFor(argv: string[]): Promise<CliError> {
  try {
    await assertKnownFlags(main, argv);
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error(`expected ${argv.join(" ")} to be refused`);
}

async function accepts(argv: string[]): Promise<void> {
  await expect(assertKnownFlags(main, argv)).resolves.toBeUndefined();
}

describe("refusing a flag the command does not have", () => {
  it("refuses the flags that caused a real mis-disclosure, naming what the command takes", async () => {
    // `search` filters by inline query syntax (`from:`, `source:`), so these
    // are the flags a caller reasonably invents. Accepting them silently made
    // the query a free-text search for the id and returned a confident,
    // unfiltered result set with exit 0.
    const err = await refusalFor(["search", "a fictional subject", "--from", "p_123"]);

    expect(err.exitCode).toBe(EXIT_USER_ERROR);
    expect(err.message).toContain("Unknown option: --from");
    expect(err.message).toContain("--limit");
    expect(err.message).toContain("--json");
  });

  it("refuses it whatever else is on the line, including after valid flags", async () => {
    const err = await refusalFor(["search", "x", "--limit", "1", "--source", "gmail", "--json"]);
    expect(err.message).toContain("Unknown option: --source");
  });

  it("suggests the nearest option for a typo", async () => {
    expect((await refusalFor(["search", "x", "--limt", "3"])).message).toContain(
      "Did you mean --limit?",
    );
  });

  it("lists the universal options for a command that declares none of its own", async () => {
    // `watch restamp` declares no arguments, but still answers to `--json` and
    // `--help`, so the list it offers is short and true rather than empty.
    const err = await refusalFor(["watch", "restamp", "--force"]);
    expect(err.message).toContain("Unknown option: --force");
    expect(err.message).toContain("Available options: --help, --json, --version");
  });

  it("refuses an unknown flag on a group node", async () => {
    expect((await refusalFor(["keyring", "--nonsense"])).message).toContain(
      "Unknown option: --nonsense",
    );
  });
});

describe("what it must keep accepting", () => {
  it("accepts --json on a command that never declares it", async () => {
    // Machine-readable output is read straight off argv by the output helpers,
    // so every command honours `--json` whether or not it declares one.
    await accepts(["watch", "list", "--json"]);
    await accepts(["codex", "status", "--json"]);
    await accepts(["codex", "update", "--check", "--json"]);
    await accepts(["codex", "update", "--dry-run", "--yes"]);
  });

  it("accepts help and version anywhere", async () => {
    await accepts(["search", "x", "--help"]);
    await accepts(["search", "-h"]);
    await accepts(["--version"]);
    await accepts(["-V"]);
  });

  it("accepts a declared flag in both its kebab and camel spellings", async () => {
    // The parser aliases one to the other, so refusing either would refuse a
    // spelling that works.
    await accepts(["doctor", "--fix-permissions"]);
    await accepts(["doctor", "--fixPermissions"]);
  });

  it("accepts the negated form of a boolean", async () => {
    await accepts(["doctor", "--no-security"]);
  });

  it("accepts a short alias", async () => {
    await accepts(["search", "x", "-v"]);
    await accepts(["status", "-w"]);
    await accepts(["service", "logs", "-f", "-n", "20"]);
  });

  it("does not read a declared flag's dash-leading value as a flag", async () => {
    // `--limit -5` passes "-5" as the limit. Treating the value as a flag would
    // refuse a line the parser handles correctly.
    await accepts(["search", "x", "--limit", "-5"]);
  });

  it("accepts the =value form", async () => {
    await accepts(["search", "x", "--limit=3"]);
  });

  it("accepts a group's flags on the group, because the group forwards its argv", async () => {
    // `omnesis keyring` with no verb runs `keyring status` with the same argv,
    // so `--backend` reaches a command that declares it.
    await accepts(["keyring", "--backend", "passphrase"]);
    await accepts(["dev-annotations", "--all"]);
  });

  it("accepts the flags the membership verbs declare", async () => {
    await accepts(["sources", "join", "notes-synth:local", "--device", "Studio-Mini", "--json"]);
    await accepts(["sources", "detach", "notes-synth:local", "--device", "Studio-Mini"]);
    await accepts(["sources", "members", "notes-synth:local", "--json"]);
    expect(
      (await refusalFor(["sources", "members", "notes-synth:local", "--device", "x"])).message,
    ).toContain("Unknown option: --device");
  });

  it("leaves positionals alone, including a whole opaque tail", async () => {
    // Source patterns arrive as an untyped tail; none of them is a flag.
    await accepts(["sources", "resync", "gmail:", "apple:"]);
    await accepts(["sql", "SELECT 1"]);
  });
});

/**
 * The check is only worth having if it is actually wired into the entrypoint.
 * Every test above calls it directly and would keep passing if the one call
 * site were deleted — so this one drives the real binary instead.
 */
describe("the binary itself", () => {
  const execFileAsync = promisify(execFile);
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

  /** No gateway is reachable and none is needed: the refusal precedes any call. */
  const env = {
    ...process.env,
    OMNESIS_CONFIG_DIR: "/tmp/omnesis-unknown-flags-test",
    OMNESIS_GATEWAY_URL: "https://127.0.0.1:19999",
    OMNESIS_INSECURE_TLS: "1",
  };

  async function run(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("npx", ["tsx", entry, ...args], { env });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("exits non-zero on a flag that does not exist, and says so on stderr", async () => {
    const result = await run(["search", "a fictional subject", "--from", "p_123"]);

    expect(result.code).toBe(EXIT_USER_ERROR);
    expect(result.stderr).toContain("Unknown option: --from");
    expect(result.stderr).toContain("Available options:");
    // The command must not have run. Silently dropping the flag returned a
    // full, confident, unfiltered result set on stdout with exit 0.
    expect(result.stdout).toBe("");
  }, 60_000);
});

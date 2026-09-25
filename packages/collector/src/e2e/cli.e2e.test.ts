// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * CLI end-to-end coverage.
 *
 * Boots a real gateway against the `e2e-minimal` universe, syncs every
 * source, then execs `npx tsx packages/cli/src/index.ts <cmd>` against
 * it and asserts on exit code + stdout shape. Covers the dozen most-used
 * read + admin commands so a refactor of the CLI router, an HTTP-route
 * rename, or an auth/scope regression surfaces before it ships.
 *
 * Not covered (intentional, out of scope for this suite):
 *   - Interactive flows: `sources add`, `creds set`, `tokens create`,
 *     anything that opens a `@clack/prompts` picker. Those want a TUI
 *     harness, not a child-process exec.
 *   - Write paths: `triggers create`, `models pull`. The point of the
 *     suite is regression protection on read-side wiring, which is the
 *     blast radius an LLM-edit is most likely to hit silently.
 */

import "./synth-env.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const CLI_ENTRY = "packages/cli/src/index.ts";
const CLI_TIMEOUT_MS = 30_000;
/** `EXIT_USER_ERROR` from `@omnesis/cli-shared`, which this package does not depend on. */
const EXIT_USER_ERROR = 2;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

describe("CLI end-to-end (e2e-minimal)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    await harness.refreshSearchSnapshot();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("`omnesis health --json` reports ok", async () => {
    const r = await runCli(harness, ["health", "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { ok?: boolean; status?: string };
    // /health returns `{ status: "ok" }` per packages/gateway/src/http/routes/status.ts.
    expect(parsed.ok === true || parsed.status === "ok").toBe(true);
  });

  test("`omnesis whoami --json` returns the caller identity", async () => {
    const r = await runCli(harness, ["whoami", "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // /whoami returns the caller's token shape — at minimum a scope field.
    // Loose schema check so this test doesn't break on additive fields.
    expect(parsed).toBeTypeOf("object");
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  test("`omnesis self set` writes config.self and `self show` reads it back", async () => {
    const set = await runCli(harness, [
      "self",
      "set",
      "--name",
      "Maya",
      "--email",
      "me@example.com",
      "--phone",
      "+12025550123",
    ]);
    expect(set.exitCode, set.stderr).toBe(0);
    expect(set.stdout).toContain("Self identity updated");

    const show = await runCli(harness, ["self", "show"]);
    expect(show.exitCode, show.stderr).toBe(0);
    expect(show.stdout).toContain("Maya");
    expect(show.stdout).toContain("me@example.com");
    expect(show.stdout).toContain("+12025550123");
  });

  test("`omnesis status` lists every seeded source", async () => {
    const r = await runCli(harness, ["status"]);
    expect(r.exitCode, r.stderr).toBe(0);
    // Spot-check a few source IDs that e2e-minimal declares in its
    // manifest. Substring match (not snapshot) because status renders
    // a TTY-styled table whose exact width depends on tty detection.
    const sourceIds = harness.getSourceIds();
    for (const id of ["gmail", "whatsapp-messages", "notion-pages"]) {
      expect(r.stdout, `status output should mention ${id}`).toContain(id);
    }
    expect(sourceIds.length).toBeGreaterThan(0);
  });

  test("`omnesis sources list` runs cleanly and queries /admin/sources", async () => {
    const r = await runCli(harness, ["sources", "list"]);
    expect(r.exitCode, r.stderr).toBe(0);
    // The harness registers every universe source as the roster device that
    // syncs it, so the listing carries the seed sources. The point of this
    // test is the wiring: the cli reached the gateway, the admin endpoint
    // responded, and the cli rendered the rows.
    expect(r.stdout).toContain("gmail");
    expect(r.stdout).not.toContain("No sources registered");
  });

  test("`omnesis sources members <id>` lists the collector hosting a seeded source", async () => {
    const sourceId = seededSourceId(harness, "gmail");
    const host = harness.deviceForSource(sourceId);
    const r = await runCli(harness, ["sources", "members", sourceId]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(sourceId);
    expect(r.stdout).toContain(host.name);

    const asJson = await runCli(harness, ["sources", "members", sourceId, "--json"]);
    const parsed = parseJsonFromCli(asJson.stdout) as {
      sourceId: string;
      multiDeviceMode: string;
      members: Array<{ deviceId: string; name: string; kind: string }>;
    };
    expect(parsed.sourceId).toBe(sourceId);
    // e2e-minimal announces no multi-device mode, so every type is exclusive.
    expect(parsed.multiDeviceMode).toBe("exclusive");
    expect(parsed.members.map((m) => m.deviceId)).toEqual([host.deviceId]);
    expect(parsed.members[0]).toMatchObject({ name: host.name, kind: "collector" });
  });

  test("`omnesis sources detach` refuses to remove a source's last host", async () => {
    const sourceId = seededSourceId(harness, "gmail");
    const host = harness.deviceForSource(sourceId);
    let r: CliResult;
    try {
      r = await execCli(harness, ["sources", "detach", sourceId, "--device", host.name, "--yes"]);
    } catch (err) {
      r = errToCliResult(err);
    }
    expect(r.exitCode).toBe(EXIT_USER_ERROR);
    const output = r.stdout + r.stderr;
    expect(output).toContain("last host");
    expect(output).toContain("remove the source");
    // The refusal left the membership as it was.
    const after = await runCli(harness, ["sources", "members", sourceId, "--json"]);
    expect((parseJsonFromCli(after.stdout) as { members: unknown[] }).members).toHaveLength(1);
  });

  test("`omnesis sources join` refuses an exclusive source, naming its host", async () => {
    const sourceId = seededSourceId(harness, "gmail");
    const host = harness.deviceForSource(sourceId);
    // e2e-minimal pairs one collector and two phones: the joiner is a phone,
    // so the refusal says a phone cannot host the source instead of offering
    // a move (moves land on collectors only).
    const joiner = harness.getDevices().find((d) => d.kind !== "collector");
    expect(joiner, "e2e-minimal pairs a phone").toBeDefined();
    let r: CliResult;
    try {
      r = await execCli(harness, ["sources", "join", sourceId, "--device", joiner!.name]);
    } catch (err) {
      r = errToCliResult(err);
    }
    expect(r.exitCode).toBe(EXIT_USER_ERROR);
    const output = r.stdout + r.stderr;
    expect(output).toContain(host.name);
    expect(output).toContain(`${joiner!.name} is a ${joiner!.kind} device and cannot host it`);
    expect(output).not.toContain("omnesis sources move");
  });

  test("`omnesis sources resync --yes` wipes a seeded source and sends the sync to its host", async () => {
    const sourceId = seededSourceId(harness, "notion-pages");
    const host = harness.deviceForSource(sourceId);
    const r = await runCli(harness, ["sources", "resync", sourceId, "--yes"]);
    expect(r.exitCode, r.stderr).toBe(0);
    // The harness's collectors hold no WS connection, so the gateway has no
    // online member to send the sync to; a connected host is named instead.
    expect(r.stdout).toMatch(
      new RegExp(`Resync (sent to ${host.name}|queued; no member is online): ${sourceId}`),
    );
    expect(r.stdout).toContain("Every document of the source was deleted.");

    const asJson = await runCli(harness, ["sources", "resync", sourceId, "--yes", "--json"]);
    const parsed = parseJsonFromCli(asJson.stdout) as { deviceIds: string[] };
    expect(parsed).toMatchObject({ sourceId, ok: true, scope: "source" });
    expect(parsed.deviceIds.every((id) => id === host.deviceId)).toBe(true);
  });

  test("`omnesis sources resync --device` refuses a source whose members share one cursor", async () => {
    const sourceId = seededSourceId(harness, "notion-pages");
    const phone = harness.getDevices().find((d) => d.kind !== "collector");
    expect(phone, "e2e-minimal pairs a phone").toBeDefined();
    let r: CliResult;
    try {
      r = await execCli(harness, ["sources", "resync", sourceId, "--device", phone!.name, "--yes"]);
    } catch (err) {
      r = errToCliResult(err);
    }
    expect(r.exitCode).toBe(EXIT_USER_ERROR);
    const output = r.stdout + r.stderr;
    expect(output).toContain(`${sourceId} syncs as exclusive`);
    expect(output).toContain("share one cursor");
    expect(output).toContain("Resync it without --device.");
  });

  test("`omnesis search marathon` finds the gmail about marathon training", async () => {
    const r = await runCli(harness, ["search", "marathon"]);
    // Search may exit 0 even with zero hits, but if it printed nothing
    // we want to know — assert there's at least one document line.
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.length, "search should produce output").toBeGreaterThan(0);
    // The e2e-minimal gmail fixture's first three messages include
    // "Marathon training plan — week 6" — verify search reached it.
    expect(r.stdout.toLowerCase()).toContain("marathon");
  });

  test("`omnesis analytics --json` returns analytics for the synth corpus", async () => {
    const r = await runCli(harness, ["analytics", "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    // Even on a freshly-seeded corpus analytics should return a parseable
    // payload. Exact shape varies; loose check.
    const parsed = JSON.parse(r.stdout) as unknown;
    expect(parsed).toBeTypeOf("object");
  });

  test("`omnesis --version` prints the version", async () => {
    const r = await runCli(harness, ["--version"]);
    expect(r.exitCode, r.stderr).toBe(0);
    // Version line is the bare semver-ish string.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("`omnesis trail <id> --json` returns an EventTrail payload", async () => {
    const docs = await harness.gatewayJson<{
      documents: Array<{ id: string }>;
    }>("/documents/recent/gmail:john.smith@example.com?limit=1");
    expect(docs.documents.length).toBeGreaterThan(0);
    const docId = docs.documents[0]!.id;

    const r = await runCli(harness, ["trail", docId, "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const trail = parseJsonFromCli(r.stdout) as {
      seeds: string[];
      events: Array<{ eventId: string; at: string | null; kind: string }>;
      truncated: boolean;
      stats: { visited: number; elapsedMs: number; maxDepthReached: number };
    };
    expect(trail.seeds.length).toBeGreaterThan(0);
    expect(trail.seeds).toContain(`doc:${docId}`);
    expect(trail.events.length).toBeGreaterThan(0);
    expect(trail.events[0]!.kind).toBe("seed");
    expect(typeof trail.truncated).toBe("boolean");
    expect(trail.stats.visited).toBeGreaterThan(0);
  });

  test("`omnesis trail <prefix>` accepts a prefix and returns the trail", async () => {
    const docs = await harness.gatewayJson<{
      documents: Array<{ id: string }>;
    }>("/documents/recent/gmail:john.smith@example.com?limit=1");
    expect(docs.documents.length).toBeGreaterThan(0);
    const docId = docs.documents[0]!.id;
    const prefix = docId.slice(0, 8);

    const r = await runCli(harness, ["trail", prefix, "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const trail = parseJsonFromCli(r.stdout) as { seeds: string[] };
    expect(trail.seeds).toContain(`doc:${docId}`);
  });

  test("`omnesis trail <id> --depth 1 --json` respects the depth flag", async () => {
    const docs = await harness.gatewayJson<{
      documents: Array<{ id: string }>;
    }>("/documents/recent/gmail:john.smith@example.com?limit=1");
    const docId = docs.documents[0]!.id;

    const r = await runCli(harness, ["trail", docId, "--depth", "1", "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const trail = parseJsonFromCli(r.stdout) as {
      stats: { maxDepthReached: number };
    };
    expect(trail.stats.maxDepthReached).toBeLessThanOrEqual(1);
  });

  test("`omnesis trail nonexistent-id` fails with a useful error", async () => {
    let r: CliResult;
    try {
      r = await execCli(harness, ["trail", "zzz-no-such-doc-999"]);
    } catch (err) {
      r = errToCliResult(err);
    }
    expect(r.exitCode).not.toBe(0);
    const output = r.stdout + r.stderr;
    expect(output.toLowerCase()).toMatch(/not found|document not found/);
  });

  test("`omnesis devices redeem --save` exchanges a pairing code for a working token", async () => {
    // Mint a pairing code via the admin API (the harness token is admin).
    const pair = await harness.gatewayJson<{ pairingCode?: string; error?: string }>(
      "/admin/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          name: "e2e-redeem-cli",
          kind: "cli",
          scopes: ["read"],
        }),
      },
    );
    expect(pair.pairingCode, JSON.stringify(pair)).toBeTruthy();

    const saveDir = join(tmpdir(), `omnesis-cli-e2e-redeem-${randomUUID()}`);
    const tokenPath = join(saveDir, "cli-token");
    try {
      const r = await runCli(harness, [
        "devices",
        "redeem",
        pair.pairingCode!,
        "--gateway-url",
        harness.gatewayUrl,
        "--save",
        tokenPath,
      ]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain("e2e-redeem-cli");
      expect(r.stdout).toContain(tokenPath);

      // Saved token: parent dir created, file mode 0600, authenticates.
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      const token = readFileSync(tokenPath, "utf8").trim();
      expect(token.length).toBeGreaterThan(8);
      const who = await fetch(`${harness.gatewayUrl}/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(who.status).toBe(200);
      const ident = (await who.json()) as { deviceName: string | null; scopes: string[] };
      expect(ident.deviceName).toBe("e2e-redeem-cli");
      expect(ident.scopes).toContain("read");
    } finally {
      rmSync(saveDir, { recursive: true, force: true });
    }
  });

  test("`omnesis devices redeem` with a bogus code fails with a friendly error", async () => {
    let r: CliResult;
    try {
      r = await execCli(harness, [
        "devices",
        "redeem",
        "ZZZZ-0000",
        "--gateway-url",
        harness.gatewayUrl,
      ]);
    } catch (err) {
      r = errToCliResult(err);
    }
    expect(r.exitCode).not.toBe(0);
    expect((r.stdout + r.stderr).toLowerCase()).toContain("invalid or expired");
  });

  test("unauthenticated CLI invocation fails cleanly (no panic)", async () => {
    // No OMNESIS_TOKEN override; the cli will fall back to
    // ~/.config/omnesis/token. We point at our test gateway, so the
    // token from the user's prod config (if any) won't match our test
    // gateway's token, OR there's no prod token at all. Either way we
    // expect a graceful non-zero exit with a useful message — NOT a
    // crash, hang, or unhandled rejection.
    let r: CliResult;
    try {
      r = await execCli(harness, ["whoami"], {
        env: {
          ...process.env,
          OMNESIS_GATEWAY_URL: harness.gatewayUrl,
          // Force-clear the token so the auth fallback fires deterministically.
          OMNESIS_TOKEN: "",
          OMNESIS_CONFIG_DIR: "/tmp/nope-not-a-real-dir-cli-e2e",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
      });
    } catch (err) {
      // execFile throws on non-zero exit codes; map to CliResult.
      r = errToCliResult(err);
    }
    expect(r.exitCode).not.toBe(0);
    // No unhandled exception or stack trace in stderr — should be a
    // clean message from the cli-shared runner. Stack traces contain
    // "    at " (with a node frame), which is the smoking gun for
    // a thrown unhandled error.
    expect(r.stderr).not.toContain("UnhandledPromiseRejection");
  });

  test("`omnesis brain` refuses cleanly when the Briefs feature is hidden", async () => {
    // This harness boots without OMNESIS_EXPERIMENTAL and without a
    // `background-agent` assignment, so the feature gate is off and the
    // /admin/brain routes 404. The CLI must turn that into a clear
    // refusal, not a bare "Not found". Reads refuse on visibility (not
    // activity), so the message names the experimental switch rather
    // than the model assignment. The active-path coverage lives in
    // briefs-cli.e2e.test.ts.
    let r: CliResult;
    try {
      r = await execCli(harness, ["brain", "loops"]);
    } catch (err) {
      r = errToCliResult(err);
    }
    expect(r.exitCode).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Omnesis Brain is experimental and currently hidden");
    expect(out).toContain("OMNESIS_EXPERIMENTAL=1");
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function runCli(harness: SyntheticE2EHarness, args: string[]): Promise<CliResult> {
  try {
    return await execCli(harness, args);
  } catch (err) {
    // execFile rejects on non-zero exit, but tests using runCli expect
    // exit 0. Re-throw with the stderr inlined for diagnostics; preserve
    // the original via `cause` so the harness can drill into the
    // child_process error if needed.
    const r = errToCliResult(err);
    throw new Error(
      `cli ${args.join(" ")} exited ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      { cause: err },
    );
  }
}

async function execCli(
  harness: SyntheticE2EHarness,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  const env = opts.env ?? {
    ...process.env,
    OMNESIS_GATEWAY_URL: harness.gatewayUrl,
    OMNESIS_TOKEN: harness.apiKey,
    OMNESIS_CONFIG_DIR: harness.getConfigDir(),
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    // Force non-TTY behaviour so output is plain text we can grep.
    NO_COLOR: "1",
    CI: "1",
  };
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr, exitCode: 0 };
}

/** The seeded source of one type; e2e-minimal declares exactly one account per type. */
function seededSourceId(harness: SyntheticE2EHarness, type: string): string {
  const id = harness.getSourceIds().find((sourceId) => sourceId.startsWith(`${type}:`));
  if (!id) throw new Error(`e2e-minimal seeds no ${type} source`);
  return id;
}

function parseJsonFromCli(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start === -1) throw new SyntaxError(`No JSON object in CLI output: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

function errToCliResult(err: unknown): CliResult {
  const e = err as { stdout?: string; stderr?: string; code?: number | string };
  return {
    stdout: typeof e.stdout === "string" ? e.stdout : "",
    stderr: typeof e.stderr === "string" ? e.stderr : "",
    exitCode: typeof e.code === "number" ? e.code : Number(e.code ?? -1),
  };
}

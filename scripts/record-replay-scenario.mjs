#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * record-replay-scenario.mjs — record a real agent SSE stream into a replay
 * cassette.
 *
 * Boots the synthetic-corpus harness (its OWN isolated gateway on a high port,
 * in a throwaway config dir — never the live instance), wires it to the
 * gateway's *configured* agent backend (read read-only from the operator's
 * real config dir; FAIL-LOUD if no agent is configured — it never silently
 * falls back to a stub), drives one prompt, captures the real `/agent/events`
 * SSE stream, and serialises it to `<universe>/agent-demos/<name>.jsonl` plus a
 * sibling `<name>.meta.json`.
 *
 * Safety: only ids the recorder itself minted (the session + message id) are
 * placeholder-ized — those mappings are known with certainty. Anything ELSE
 * that looks real (an email off a reserved domain, a phone, an IP, a
 * credential shape, a long hex / UUID / base64 token) is FLAGGED and the
 * recorder REFUSES to write the cassette, naming the offending lines — so a
 * leaked secret or un-mapped runtime id can never be silently recorded. Review
 * and re-run after redacting.
 *
 * Usage:
 *   scripts/record-replay-scenario.mjs --name <scenario> --prompt "<text>" \
 *       [--universe default] [--triggers "a,b,c"] [--after-ms 30] [--force] \
 *       [--out <dir>] [--timeout-ms 120000]
 *
 * The recorded cassette is replayable by `ReplayBackend` and round-trips
 * through `validate-universes` (the cassette parses + serialises stably).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCassette, RecorderGuardError } from "./lib/replay-recorder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// ── arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    universe: "default",
    afterMs: 30,
    timeoutMs: 120_000,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--name":
        opts.name = next();
        break;
      case "--prompt":
        opts.prompt = next();
        break;
      case "--universe":
        opts.universe = next();
        break;
      case "--triggers":
        opts.triggers = next();
        break;
      case "--after-ms":
        opts.afterMs = Number(next());
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number(next());
        break;
      case "--out":
        opts.out = next();
        break;
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        fail(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`record-replay-scenario: ${msg}\n`);
  process.exit(1);
}

const USAGE =
  'Usage: scripts/record-replay-scenario.mjs --name <scenario> --prompt "<text>"\n' +
  "       [--universe default] [--triggers a,b,c] [--after-ms 30] [--force]\n" +
  "       [--out <dir>] [--timeout-ms 120000]\n";

// ── configured-backend resolution (read-only, fail-loud) ─────────────────────

/**
 * Resolve the operator's configured `agent` backend from their real config dir,
 * read-only. Returns the `extraInference` block (assignment + the referenced
 * HTTP backend definition, if any) for the harness to inject. FAILS LOUD when
 * no agent is configured — this recorder records a REAL agent stream by design,
 * so a missing/null/disabled assignment is an error, not a stub fallback.
 */
function resolveConfiguredAgent() {
  const configDir =
    process.env.OMNESIS_RECORD_CONFIG_DIR ??
    process.env.OMNESIS_CONFIG_DIR ??
    join(homedir(), ".config", "omnesis");
  const omnesisPath = join(configDir, "omnesis.json");
  if (!existsSync(omnesisPath)) {
    fail(
      `no configured agent backend found — ${omnesisPath} does not exist.\n` +
        `Set inference.assignments.agent in your omnesis.json (e.g. "anthropic/claude-sonnet-4-6"),\n` +
        `or point OMNESIS_RECORD_CONFIG_DIR at a config dir that has one. The recorder records a\n` +
        `REAL agent stream and will not fall back to a stub.`,
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(omnesisPath, "utf-8"));
  } catch (err) {
    fail(`could not parse ${omnesisPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const assignment = cfg?.inference?.assignments?.agent;
  if (assignment === undefined || assignment === null || assignment === "") {
    fail(
      `no configured agent backend — inference.assignments.agent is unset/null in ${omnesisPath}.\n` +
        `Configure a real agent backend before recording (the recorder never stubs the agent).`,
    );
  }
  if (assignment === "replay") {
    fail(
      `inference.assignments.agent is "replay" in ${omnesisPath} — that is the deterministic\n` +
        `cassette player, not a real model. Configure a real agent backend to RECORD a new cassette.`,
    );
  }

  const extraInference = { assignments: { agent: assignment } };
  // Assignment is "<backendKey>/<model>". A custom HTTP backend key references
  // inference.backends.<key>; the built-ins (anthropic, local) carry no block.
  const backendKey = String(assignment).split("/")[0];
  const backends = cfg?.inference?.backends ?? {};
  if (backends[backendKey]) {
    extraInference.backends = { [backendKey]: backends[backendKey] };
  } else if (!["anthropic", "local"].includes(backendKey)) {
    fail(
      `agent assignment "${assignment}" references backend "${backendKey}", but ` +
        `inference.backends.${backendKey} is not defined in ${omnesisPath}.`,
    );
  }
  return { assignment, extraInference };
}

// ── SSE driving ──────────────────────────────────────────────────────────────

/**
 * Open SSE, create a session, post the prompt, and collect every event for that
 * session until `agent.message.end` for the message we sent. Returns the raw
 * events plus the minted ids (so the caller can placeholder-ize with certainty).
 */
async function recordStream(gatewayUrl, apiKey, prompt, timeoutMs) {
  const sse = await fetch(`${gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();
  try {
    const sessionRes = await fetch(`${gatewayUrl}/agent/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!sessionRes.ok) {
      throw new Error(`session create failed: ${sessionRes.status} ${await sessionRes.text()}`);
    }
    const { sessionId } = await sessionRes.json();

    const msgRes = await fetch(`${gatewayUrl}/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    if (!msgRes.ok) {
      throw new Error(`message send failed: ${msgRes.status} ${await msgRes.text()}`);
    }
    const { messageId } = await msgRes.json();

    const events = await readUntilEnd(reader, sessionId, messageId, timeoutMs);
    return { events, ids: { sessionId, messageId } };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function readUntilEnd(reader, sessionId, messageId, timeoutMs) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true }), remaining)),
    ]);
    if (next.done || !next.value) break;
    buffer += decoder.decode(next.value, { stream: true });
    let blockEnd;
    while ((blockEnd = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, blockEnd);
      buffer = buffer.slice(blockEnd + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const payload = parsed.payload;
      if (!payload || typeof payload !== "object") continue;
      if (payload.sessionId !== sessionId) continue;
      events.push(parsed);
      if (parsed.type === "agent.message.end" && payload.messageId === messageId) {
        return events;
      }
    }
  }
  return events;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!opts.name) fail(`--name is required\n${USAGE}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.name)) {
    fail(`--name must be a kebab-case slug (got "${opts.name}")`);
  }
  if (!opts.prompt) fail(`--prompt is required\n${USAGE}`);
  if (!Number.isFinite(opts.afterMs) || opts.afterMs < 0) fail(`--after-ms must be >= 0`);

  const { assignment, extraInference } = resolveConfiguredAgent();

  const outDir = opts.out ?? join(REPO_ROOT, "evals", "universes", opts.universe, "agent-demos");
  const jsonlPath = isAbsolute(outDir)
    ? join(outDir, `${opts.name}.jsonl`)
    : join(REPO_ROOT, outDir, `${opts.name}.jsonl`);
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  if (existsSync(jsonlPath) && !opts.force) {
    fail(`${jsonlPath} already exists — pass --force to overwrite.`);
  }

  process.env.OMNESIS_SYNTHETIC = "1";
  process.env.OMNESIS_SYNTH_UNIVERSE = opts.universe;

  // Dynamic import AFTER OMNESIS_SYNTHETIC is set (the harness's source
  // discovery runs on first import). tsx resolves the .ts via the workspace.
  const { SyntheticE2EHarness } = await import(
    join(REPO_ROOT, "packages", "collector", "src", "e2e", "synth-harness.ts")
  );

  process.stderr.write(
    `Recording "${opts.name}" against configured agent "${assignment}" (universe ${opts.universe})…\n`,
  );

  const harness = new SyntheticE2EHarness({
    gatewayMode: "synthetic",
    universe: opts.universe,
    extraInference,
  });
  await harness.start();
  try {
    // Sync every source so the agent has a populated corpus to ground on.
    const sourceIds = harness.getSourceIds();
    await Promise.all(sourceIds.map((id) => harness.triggerSyncAndWait(id, 60_000)));

    const { events, ids } = await recordStream(
      harness.gatewayUrl,
      harness.apiKey,
      opts.prompt,
      opts.timeoutMs,
    );

    if (events.length === 0) {
      fail(
        "agent produced zero events — nothing to record (is the configured backend reachable?).",
      );
    }
    const ended = events.some((e) => e.type === "agent.message.end");
    if (!ended) {
      fail(
        `agent stream never reached agent.message.end within ${opts.timeoutMs}ms — refusing to ` +
          `record a truncated cassette.`,
      );
    }

    // Build + guard the cassette. buildCassette THROWS RecorderGuardError on any
    // real-looking token it couldn't certainly placeholder-ize.
    const { jsonl } = buildCassette(events, ids, { afterMs: opts.afterMs });

    mkdirSync(dirname(jsonlPath), { recursive: true });
    const header =
      `# Recorded by scripts/record-replay-scenario.mjs against agent "${assignment}".\n` +
      `# Prompt: ${opts.prompt.replace(/\n/g, " ")}\n`;
    writeFileSync(jsonlPath, header + jsonl);

    const triggers = opts.triggers
      ? opts.triggers
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [opts.prompt];
    writeFileSync(metaPath, JSON.stringify({ triggers }, null, 2) + "\n");

    process.stderr.write(
      `Wrote ${jsonlPath} (${events.length} events) + ${metaPath}.\n` +
        `Review both before committing.\n`,
    );
  } finally {
    await harness.destroy();
  }
}

main().catch((err) => {
  if (err instanceof RecorderGuardError) {
    process.stderr.write(`\n${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`record-replay-scenario failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});

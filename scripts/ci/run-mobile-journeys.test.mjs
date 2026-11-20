// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the real journey script from a sandbox checkout whose
 * `synth-gateway.sh` stands in for the gateway: its `start` writes what a
 * gateway that ran leaves in its config dir, then fails, so the script exits
 * through its cleanup without a simulator, an emulator or a real gateway.
 */
function runJourneysWithFailingGateway({ keptProfile }) {
  const sandbox = mkdtempSync(join(tmpdir(), "omnesis-journeys-artifacts-"));
  sandboxes.push(sandbox);
  const scripts = join(sandbox, "checkout", "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(
    join(root, "scripts/run-mobile-journeys.sh"),
    join(scripts, "run-mobile-journeys.sh"),
  );
  const profileLines = keptProfile
    ? [
        'mkdir -p "$OMNESIS_CONFIG_DIR/diagnostics/stalls"',
        'echo "{}" >"$OMNESIS_CONFIG_DIR/diagnostics/stalls/profile-2026-01-01T00-00-00-000Z.json"',
      ]
    : [];
  writeFileSync(
    join(scripts, "synth-gateway.sh"),
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == start ]]; then',
      '  mkdir -p "$OMNESIS_CONFIG_DIR/logs"',
      '  echo "gateway ran" >"$OMNESIS_CONFIG_DIR/logs/gateway.log"',
      ...profileLines.map((line) => `  ${line}`),
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(join(scripts, "synth-gateway.sh"), 0o755);
  // A model already on the machine, so nothing is downloaded.
  const home = join(sandbox, "home");
  mkdirSync(join(home, ".config/omnesis/models"), { recursive: true });
  writeFileSync(join(home, ".config/omnesis/models/nomic-embed-text-v1.5.Q8_0.gguf"), "");
  const artifacts = join(sandbox, "artifacts");
  const result = spawnSync("bash", [join(scripts, "run-mobile-journeys.sh"), "android"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OMNESIS_CONFIG_DIR: join(sandbox, "gateway"),
      OMNESIS_GATEWAY_PORT: "17999",
      OMNESIS_JOURNEY_ARTIFACTS: artifacts,
    },
  });
  return { result, artifacts };
}

describe("scripts/run-mobile-journeys.sh artifacts", () => {
  it("keeps the gateway's logs and stall profiles when the run fails", () => {
    const { result, artifacts } = runJourneysWithFailingGateway({ keptProfile: true });
    expect(result.status).toBe(1);
    expect(readdirSync(join(artifacts, "gateway-logs"))).toContain("gateway.log");
    expect(readdirSync(join(artifacts, "gateway-logs/stall-profiles"))).toEqual([
      "profile-2026-01-01T00-00-00-000Z.json",
    ]);
  });

  it("adds no stall-profile directory when the gateway kept none", () => {
    const { result, artifacts } = runJourneysWithFailingGateway({ keptProfile: false });
    expect(result.status).toBe(1);
    expect(readdirSync(join(artifacts, "gateway-logs"))).toContain("gateway.log");
    expect(existsSync(join(artifacts, "gateway-logs/stall-profiles"))).toBe(false);
  });
});

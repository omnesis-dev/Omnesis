// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const script = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const functions = script.slice(
  script.indexOf("print_telemetry_notice() {"),
  script.indexOf("main() {", script.indexOf("print_telemetry_notice() {")),
);
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runNotice(clientOnly = "0", extra = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-installer-telemetry-"));
  directories.push(configDir);
  writeFileSync(
    join(configDir, "omnesis.json"),
    '{"telemetry":{"enabled":false,"acknowledged":true}}',
  );
  const output = execFileSync(
    "sh",
    [
      "-c",
      `${functions}
info() { printf '%s\\n' "$*"; }
warn() { printf '%s\\n' "$*" >&2; }
set_env() { printf '%s=%s\\n' "$1" "$2" >> "$CONFIG_DIR/.env"; }
print_telemetry_notice
record_telemetry_notice
`,
    ],
    {
      encoding: "utf8",
      input: "",
      timeout: 2000,
      env: {
        ...process.env,
        CONFIG_DIR: configDir,
        CLIENT_ONLY: clientOnly,
        OMNESIS_TELEMETRY: "",
        ...extra,
      },
    },
  );
  return { output, configDir };
}

describe("installer telemetry disclosure", () => {
  test("prints an unattended disclosure and records notice without changing preference", () => {
    const { output, configDir } = runNotice();
    expect(output).toContain("enabled by default");
    expect(output).toContain("Once a day");
    expect(output).toContain("rotates monthly");
    expect(output).toContain("No personal content");
    expect(output).toContain("/telemetry/enabled false");
    expect(output).toContain("OMNESIS_TELEMETRY=off");
    expect(output).not.toMatch(/Y\/n|y\/N/);
    expect(existsSync(join(configDir, "telemetry-notice-v1"))).toBe(true);
    expect(JSON.parse(readFileSync(join(configDir, "omnesis.json"), "utf8"))).toEqual({
      telemetry: { enabled: false, acknowledged: true },
    });
  });

  test("a client-only install neither discloses local reporting nor records a gateway notice", () => {
    const { output, configDir } = runNotice("1");
    expect(output).toBe("");
    expect(existsSync(join(configDir, "telemetry-notice-v1"))).toBe(false);
  });

  test.each(["off", "OFF", "false", "0", " no "])(
    "preserves installer environment opt-out %s for the daemon",
    (value) => {
      const { configDir } = runNotice("0", { OMNESIS_TELEMETRY: value });
      expect(readFileSync(join(configDir, ".env"), "utf8")).toBe("OMNESIS_TELEMETRY=off\n");
    },
  );

  test("retains explicit fixture isolation across service-manager environment resets", () => {
    const { configDir } = runNotice("0", { OMNESIS_TEST_INSTANCE: "1" });
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain("OMNESIS_TEST_INSTANCE=1\n");
  });
});

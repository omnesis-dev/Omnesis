// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedOpenClaw } from "../test-fixtures/openclaw.js";
import { openClawCapabilityConsentSupport } from "./openclaw-capability-consent.js";
import type { spawnSync } from "node:child_process";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real scripted CLI with invented help output and captured literal argv. */
function fakeOpenClaw(helpBody: string, exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "omnesis-openclaw-consent-"));
  roots.push(root);
  return scriptedOpenClaw(root, helpBody, exitCode);
}

function support(helpBody: string, exitCode = 0) {
  const fake = fakeOpenClaw(helpBody, exitCode);
  return openClawCapabilityConsentSupport(fake.env, fake.run);
}

const CONSENT_RELEASE_HELP = `Usage: openclaw plugins install [options] <path-or-spec-or-plugin>

Options:
  --accept-capabilities                 Accept the plugin's declared
                                        capabilities (default: false)
  --force                               Confirm non-ClawHub sources and
                                        overwrite an existing plugin or hook
                                        pack (default: false)
  -h, --help                            Display help for command
`;

const PRE_CONSENT_RELEASE_HELP = `Usage: openclaw plugins install [options] <path-or-spec-or-plugin>

Options:
  --dangerously-force-unsafe-install    Bypass built-in dangerous-code install
                                        blocking (default: false)
  --force                               Overwrite an existing plugin or hook
                                        pack (default: false)
  -h, --help                            Display help for command
`;

function scripted(result: {
  stdout?: string;
  stderr?: string;
  status: number | null;
  error?: Error;
}): typeof spawnSync {
  return vi.fn(() => ({
    pid: 1,
    output: [],
    signal: null,
    stdout: "",
    stderr: "",
    ...result,
  })) as unknown as typeof spawnSync;
}

describe("openClawCapabilityConsentSupport", () => {
  it("is supported when the installed OpenClaw lists the flag on plugins install", () => {
    const fake = fakeOpenClaw(CONSENT_RELEASE_HELP);
    expect(openClawCapabilityConsentSupport(fake.env, fake.run)).toBe("supported");
    expect(readFileSync(fake.argsFile, "utf8").trim().split("\n")).toEqual([
      "plugins",
      "install",
      "--help",
    ]);
  });

  it("is unsupported for a release that predates the consent gate", () => {
    expect(support(PRE_CONSENT_RELEASE_HELP)).toBe("unsupported");
  });

  it.each([
    "  --accept-capabilities-summary         Print a summary (default: false)",
    "  See x--accept-capabilities for details",
    "  --no-accept-capabilities              Refuse declared capabilities",
  ])("does not mistake a neighbouring token for the option: %s", (line) => {
    const help = `${PRE_CONSENT_RELEASE_HELP}${line}\n`;
    expect(support(help)).toBe("unsupported");
  });

  it("finds the option when a forced color setting colors the help", () => {
    const colored = CONSENT_RELEASE_HELP.replace(
      "  --accept-capabilities ",
      "  \u001b[93m--accept-capabilities\u001b[39m ",
    );
    expect(openClawCapabilityConsentSupport({}, scripted({ stdout: colored, status: 0 }))).toBe(
      "supported",
    );
  });

  it("reads help written to stderr as well as stdout", () => {
    expect(
      openClawCapabilityConsentSupport({}, scripted({ stderr: CONSENT_RELEASE_HELP, status: 0 })),
    ).toBe("supported");
  });

  it("is unknown when the help run fails, even if it printed the flag", () => {
    expect(support(CONSENT_RELEASE_HELP, 1)).toBe("unknown");
  });

  it("is unknown when the help run times out", () => {
    const timedOut = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(
      openClawCapabilityConsentSupport(
        {},
        scripted({ stdout: CONSENT_RELEASE_HELP, status: null, error: timedOut }),
      ),
    ).toBe("unknown");
  });

  it("is unknown when no openclaw can be started", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-openclaw-consent-empty-"));
    roots.push(root);
    expect(openClawCapabilityConsentSupport({ PATH: root })).toBe("unknown");
  });
});

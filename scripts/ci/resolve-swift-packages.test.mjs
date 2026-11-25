// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = join(import.meta.dirname, "resolve-swift-packages.sh");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What SwiftPM prints when the git host refuses its clones with `code`. */
const refused = (code) => `Fetching https://github.com/swhitty/SwiftDraw.git
Fetching https://github.com/apple/swift-asn1.git
warning: 'swift-asn1': skipping cache due to an error: Failed to clone repository https://github.com/apple/swift-asn1.git:
    Cloning into bare repository '/Users/runner/Library/Caches/org.swift.swiftpm/repositories/swift-asn1-7065ad2c'...
    fatal: unable to access 'https://github.com/apple/swift-asn1.git/': The requested URL returned error: ${code}
error: Failed to clone repository https://github.com/apple/swift-asn1.git:
    Cloning into bare repository '/Users/runner/work/Omnesis/Omnesis/ios/.build/repositories/swift-asn1-7065ad2c'...
    fatal: unable to access 'https://github.com/apple/swift-asn1.git/': The requested URL returned error: ${code}
`;

const RESOLVED = `Computed https://github.com/apple/swift-asn1.git at 1.7.4 (0.41s)
Working copy of https://github.com/apple/swift-asn1.git resolved at 1.7.4
`;

/**
 * Runs the script with a fake `swift` on PATH that answers its n-th call with
 * `replies[n]`: `{ status, output }`. Returns the script's result and the
 * arguments of every `swift` call.
 */
function run(replies, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-ci-swiftpm-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  replies.forEach(({ output }, index) => writeFileSync(join(dir, `reply-${index}`), output));
  const statuses = replies.map(({ status }) => status).join(" ");
  writeFileSync(
    join(bin, "swift"),
    `#!/bin/sh
echo "$*" >> "${calls}"
n=$(wc -l < "${calls}" | tr -d ' ')
cat "${dir}/reply-$((n - 1))"
set -- ${statuses}
shift $((n - 1))
exit "$1"
`,
  );
  chmodSync(join(bin, "swift"), 0o755);
  const result = spawnSync("bash", [SCRIPT, "ios"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      OMNESIS_SWIFTPM_RETRY_DELAYS: "0 0",
      ...env,
    },
  });
  const swiftCalls = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  return { ...result, calls: swiftCalls };
}

describe("scripts/ci/resolve-swift-packages.sh", () => {
  test("resolves the package once when SwiftPM succeeds", () => {
    const result = run([{ status: 0, output: RESOLVED }]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["package resolve --package-path ios"]);
    expect(result.stdout).toContain(RESOLVED);
    expect(result.stdout).toContain("Swift packages in ios resolved (attempt 1 of 3).");
    expect(result.stdout).not.toContain("::warning::");
  });

  for (const code of [403, 429, 500, 502, 503]) {
    test(`retries after the git host answers ${code}`, () => {
      const result = run([
        { status: 1, output: refused(code) },
        { status: 0, output: RESOLVED },
      ]);
      expect(result.status).toBe(0);
      expect(result.calls).toHaveLength(2);
      expect(result.stdout).toContain(
        `::warning::The git host answered HTTP ${code} while SwiftPM resolved ios (attempt 1 of 3)`,
      );
      expect(result.stdout).toContain("resolved (attempt 2 of 3).");
    });
  }

  test("retries once for each configured delay, then fails with SwiftPM's status", () => {
    const result = run(
      [403, 429, 502].map((code) => ({ status: 1, output: refused(code) })),
      { OMNESIS_SWIFTPM_RETRY_DELAYS: "0 0" },
    );
    expect(result.calls).toHaveLength(3);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "::error::The git host still answered HTTP 502 after 3 attempts to resolve the packages in ios.",
    );
  });

  for (const [name, output] of [
    ["a missing repository", refused(404)],
    ["an authentication error", refused(401)],
    [
      "a manifest error",
      "error: 'ios': Invalid manifest\nPackage.swift:12:5: error: cannot find 'packag' in scope\n",
    ],
    [
      "a version that does not exist",
      "error: Dependencies could not be resolved because no versions of 'swift-asn1' match the requirement 9.9.9\n",
    ],
  ]) {
    test(`fails at once on ${name}`, () => {
      const result = run([
        { status: 1, output },
        { status: 0, output: RESOLVED },
      ]);
      expect(result.calls).toHaveLength(1);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(output);
      expect(result.stdout).toContain(
        "::error::SwiftPM could not resolve the packages in ios; its output is above.",
      );
    });
  }
});

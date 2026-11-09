// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../../.github/workflows/swiftlint.yml", import.meta.url), "utf8"),
);

for (const name of ["swiftformat", "swiftlint"]) {
  describe(`CI ${name} pin`, () => {
    for (const matches of [true, false]) {
      test(
        matches
          ? "uses the verified binary even when PATH contains a newer tool"
          : "rejects an unexpected tool version before linting",
        () => {
          const directory = mkdtempSync(join(tmpdir(), "omnesis-swift-ci-"));
          try {
            const key = `${name.toUpperCase()}_VERSION`,
              version = workflow.env[key];
            const pinned = join(directory, `${name}-${version}`),
              shadow = join(directory, "shadow"),
              log = join(directory, "invocations");
            mkdirSync(pinned);
            mkdirSync(shadow);
            writeFileSync(join(shadow, name), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
            writeFileSync(
              join(pinned, name),
              '#!/bin/sh\ncase "$1" in --version|version) printf "%s\\n" "$FAKE_TOOL_VERSION";; *) printf "%s\\n" "$*" >> "$FAKE_TOOL_LOG";; esac\n',
              { mode: 0o755 },
            );
            const command = workflow.jobs.swiftlint.steps.find(
              (step) => step.name === `lane [${name}]`,
            ).run;
            const run = () =>
              execFileSync("bash", ["-e", "-u", "-o", "pipefail", "-c", command], {
                cwd: directory,
                env: {
                  ...process.env,
                  ...workflow.env,
                  RUNNER_TEMP: directory,
                  PATH: `${shadow}:${process.env.PATH}`,
                  FAKE_TOOL_VERSION: matches ? version : "0.0.0",
                  FAKE_TOOL_LOG: log,
                },
                stdio: ["ignore", "pipe", "pipe"],
              });
            if (matches) {
              run();
              expect(readFileSync(log, "utf8")).toContain(
                name === "swiftformat"
                  ? "--lint ios"
                  : "lint --strict --baseline .swiftlint-baseline.json",
              );
            } else {
              expect(run).toThrow();
              expect(existsSync(log)).toBe(false);
            }
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        },
      );
    }
  });
}

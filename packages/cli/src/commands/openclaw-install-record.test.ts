// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawRecordsArchive } from "./openclaw-install-record.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omnesis-openclaw-record-"));
  roots.push(root);
  return root;
}

/** An archive with invented contents, and the digests OpenClaw records for it. */
function archive(
  root: string,
  contents = "invented archive bytes",
): {
  path: string;
  integrity: string;
  shasum: string;
} {
  const path = join(root, "omnesis-agent-integration-0.0.0.tgz");
  writeFileSync(path, contents);
  const bytes = readFileSync(path);
  return {
    path,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

/**
 * A fake `openclaw` on an isolated PATH that records its arguments and prints
 * `stdout` for `plugins inspect`, exiting with `exitCode`.
 */
function fakeOpenClaw(
  root: string,
  stdout: string,
  exitCode = 0,
): { env: NodeJS.ProcessEnv; argsFile: string } {
  const argsFile = join(root, "args");
  const outFile = join(root, "inspect.out");
  writeFileSync(outFile, stdout);
  writeFileSync(
    join(root, "openclaw"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat "${outFile}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return { env: { PATH: `${root}:/usr/bin:/bin` }, argsFile };
}

function report(install: Record<string, unknown> | undefined): string {
  return JSON.stringify({
    plugin: { id: "omnesis-integration", version: "0.0.0" },
    ...(install ? { install } : {}),
  });
}

describe("openClawRecordsArchive", () => {
  it("reads the install record of the integration plugin", () => {
    const root = scratch();
    const saved = archive(root);
    const openclaw = fakeOpenClaw(root, report({ integrity: saved.integrity }));

    expect(openClawRecordsArchive(saved.path, openclaw.env)).toBe(true);
    expect(readFileSync(openclaw.argsFile, "utf8").trim().split("\n")).toEqual([
      "plugins",
      "inspect",
      "omnesis-integration",
      "--json",
    ]);
  });

  it("matches on the archive's SHA-1 when the record has no integrity", () => {
    const root = scratch();
    const saved = archive(root);
    const openclaw = fakeOpenClaw(root, report({ shasum: saved.shasum }));

    expect(openClawRecordsArchive(saved.path, openclaw.env)).toBe(true);
  });

  it("reads past a banner printed before the report", () => {
    const root = scratch();
    const saved = archive(root);
    const openclaw = fakeOpenClaw(
      root,
      `OpenClaw 0.0.0 — an invented banner.\n\n${report({ integrity: saved.integrity })}\n`,
    );

    expect(openClawRecordsArchive(saved.path, openclaw.env)).toBe(true);
  });

  it("a record of another archive is not this install", () => {
    const root = scratch();
    const saved = archive(root);
    const previous = archive(scratch(), "the previously installed archive");
    const openclaw = fakeOpenClaw(
      root,
      report({ integrity: previous.integrity, shasum: previous.shasum }),
    );

    expect(openClawRecordsArchive(saved.path, openclaw.env)).toBe(false);
  });

  it.each([
    { name: "no install record", stdout: report(undefined), exitCode: 0 },
    { name: "an unreadable report", stdout: "not json", exitCode: 0 },
    { name: "a failed inspection", stdout: "", exitCode: 1 },
  ])("$name is not evidence of an install", ({ stdout, exitCode }) => {
    const root = scratch();
    const saved = archive(root);
    const openclaw = fakeOpenClaw(root, stdout, exitCode);

    expect(openClawRecordsArchive(saved.path, openclaw.env)).toBe(false);
  });

  it("a missing archive is not evidence of an install", () => {
    const root = scratch();
    const saved = archive(root);
    const openclaw = fakeOpenClaw(root, report({ integrity: saved.integrity }));

    expect(openClawRecordsArchive(join(root, "absent.tgz"), openclaw.env)).toBe(false);
  });

  it("an openclaw that cannot be started is not evidence of an install", () => {
    const root = scratch();
    const saved = archive(root);

    expect(openClawRecordsArchive(saved.path, { PATH: root })).toBe(false);
  });
});

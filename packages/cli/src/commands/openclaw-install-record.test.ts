// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedOpenClaw } from "../test-fixtures/openclaw.js";
import { openClawSavedArchive, readOpenClawInstallRecord } from "./openclaw-install-record.js";

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
): { path: string; integrity: string; shasum: string } {
  const path = join(root, "omnesis-agent-integration-0.0.0.tgz");
  writeFileSync(path, contents);
  const bytes = readFileSync(path);
  return {
    path,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

function report(install: Record<string, unknown> | undefined): string {
  return JSON.stringify({
    plugin: { id: "omnesis-integration", version: "0.0.0" },
    ...(install ? { install } : {}),
  });
}

describe("readOpenClawInstallRecord", () => {
  it("reads the install record of the integration plugin", () => {
    const install = { integrity: "sha512-aW52ZW50ZWQ=", installedAt: "2030-01-01T00:00:00Z" };
    const openclaw = scriptedOpenClaw(scratch(), report(install));

    expect(readOpenClawInstallRecord(openclaw.env, openclaw.run)).toEqual(install);
    expect(readFileSync(openclaw.argsFile, "utf8").trim().split("\n")).toEqual([
      "plugins",
      "inspect",
      "omnesis-integration",
      "--json",
    ]);
  });

  it("reads past a banner printed before the report", () => {
    const openclaw = scriptedOpenClaw(
      scratch(),
      `OpenClaw 0.0.0 — an invented banner.\n\n${report({ shasum: "abc" })}\n`,
    );

    expect(readOpenClawInstallRecord(openclaw.env, openclaw.run)).toEqual({ shasum: "abc" });
  });

  it.each([
    { name: "a report without an install record", stdout: report(undefined), exitCode: 0 },
    { name: "an unreadable report", stdout: "not json", exitCode: 0 },
    { name: "a failed inspection", stdout: report({ shasum: "abc" }), exitCode: 1 },
  ])("$name reads as no record", ({ stdout, exitCode }) => {
    const openclaw = scriptedOpenClaw(scratch(), stdout, exitCode);

    expect(readOpenClawInstallRecord(openclaw.env, openclaw.run)).toBeNull();
  });

  it("an openclaw that cannot be started reads as no record", () => {
    expect(readOpenClawInstallRecord({ PATH: scratch() })).toBeNull();
  });
});

describe("openClawSavedArchive", () => {
  const started = Date.parse("2030-01-01T12:00:00.000Z");
  const after = "2030-01-01T12:00:05.000Z";

  it("a record this install wrote, naming the archive's integrity, is this install", () => {
    const saved = archive(scratch());

    expect(
      openClawSavedArchive({ integrity: saved.integrity, installedAt: after }, saved.path, started),
    ).toBe(true);
  });

  it("a record written before this install started is an earlier install, even of the same bytes", () => {
    const saved = archive(scratch());
    const earlier = { integrity: saved.integrity, installedAt: "2030-01-01T11:59:00.000Z" };

    expect(openClawSavedArchive(earlier, saved.path, started)).toBe(false);
  });

  it("a record timestamped within a second before the start still counts", () => {
    const saved = archive(scratch());
    const coarse = { integrity: saved.integrity, installedAt: "2030-01-01T11:59:59.500Z" };

    expect(openClawSavedArchive(coarse, saved.path, started)).toBe(true);
  });

  it.each([
    { name: "no install time", installedAt: undefined },
    { name: "an unreadable install time", installedAt: "not a time" },
  ])("a record with $name is not evidence of an install", ({ installedAt }) => {
    const saved = archive(scratch());

    expect(
      openClawSavedArchive({ integrity: saved.integrity, installedAt }, saved.path, started),
    ).toBe(false);
  });

  it("falls back to the archive's SHA-1 only when the record has no integrity", () => {
    const saved = archive(scratch());
    const other = archive(scratch(), "another invented archive");

    expect(
      openClawSavedArchive({ shasum: saved.shasum, installedAt: after }, saved.path, started),
    ).toBe(true);
    expect(
      openClawSavedArchive(
        { integrity: other.integrity, shasum: saved.shasum, installedAt: after },
        saved.path,
        started,
      ),
    ).toBe(false);
  });

  it("a record of another archive is not this install", () => {
    const saved = archive(scratch());
    const other = archive(scratch(), "the previously installed archive");

    expect(
      openClawSavedArchive(
        { integrity: other.integrity, shasum: other.shasum, installedAt: after },
        saved.path,
        started,
      ),
    ).toBe(false);
  });

  it("no record, or no archive to compare with, is not evidence of an install", () => {
    const root = scratch();
    const saved = archive(root);

    expect(openClawSavedArchive(null, saved.path, started)).toBe(false);
    expect(
      openClawSavedArchive(
        { integrity: saved.integrity, installedAt: after },
        join(root, "absent.tgz"),
        started,
      ),
    ).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROKEN_MARKER,
  GATEWAY_BOOT_FILE,
  breakGatewayBoot,
  bumpPatch,
  init,
  newestStableTag,
  nextVersion,
  release,
  rewriteManifestVersion,
} from "./fixture.mjs";

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "install-e2e-fixture-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifest(name, version) {
  return JSON.stringify({ name, version, private: true }, null, 2) + "\n";
}

/** A repository shaped like the product: lockstep manifests plus a gateway entry. */
function sourceRepo(version = "1.2.3") {
  const repo = tempDir();
  git(repo, "init", "-q");
  mkdirSync(join(repo, "packages/cli"), { recursive: true });
  mkdirSync(join(repo, "packages/gateway/src"), { recursive: true });
  mkdirSync(join(repo, "packages/other"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", private: true }) + "\n");
  writeFileSync(join(repo, "packages/cli/package.json"), manifest("cli", version));
  writeFileSync(join(repo, "packages/gateway/package.json"), manifest("gateway", version));
  writeFileSync(join(repo, "packages/other/package.json"), manifest("other", "0.0.1"));
  writeFileSync(
    join(repo, GATEWAY_BOOT_FILE),
    "// SPDX-License-Identifier: AGPL-3.0-or-later\n\nimport { x } from './x.js';\nstart(x);\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "tag", "v1.2.2");
  git(repo, "tag", "v1.2.3-beta.1");
  git(repo, "commit", "-q", "--allow-empty", "-m", "two");
  return repo;
}

const show = (remote, ref, path) => git(remote, "show", `${ref}:${path}`);

describe("pure helpers", () => {
  it("picks the newest stable tag numerically and ignores pre-releases", () => {
    expect(newestStableTag(["v0.9.0", "v0.10.0", "v0.10.1-rc.1", "latest"])).toBe("v0.10.0");
    expect(newestStableTag(["nightly"])).toBeNull();
  });

  it("bumps the patch", () => {
    expect(bumpPatch("0.5.13")).toBe("0.5.14");
  });

  it("rewrites only a manifest on the lockstep version, leaving the rest byte-for-byte", () => {
    const text =
      '{\n  "name": "a",\n  "version": "1.0.0",\n  "dependencies": { "b": "1.0.0" }\n}\n';
    expect(rewriteManifestVersion(text, "1.0.0", "1.0.1")).toBe(
      text.replace('"version": "1.0.0"', '"version": "1.0.1"'),
    );
    expect(rewriteManifestVersion(text, "2.0.0", "2.0.1")).toBeNull();
    expect(rewriteManifestVersion("not json", "1.0.0", "1.0.1")).toBeNull();
    // A nested key spelled the same way comes first: no rewrite rather than the wrong one.
    const nested = '{\n  "engines": { "version": "1.0.0" },\n  "version": "1.0.0"\n}\n';
    expect(rewriteManifestVersion(nested, "1.0.0", "1.0.1")).toBeNull();
  });

  it("puts the exit after the licence header and before the imports", () => {
    const out = breakGatewayBoot("// header\n\nimport a from 'a';\nrun();\n").split("\n");
    expect(out[0]).toBe("// header");
    expect(out[2]).toBe("if (process.argv.length > 0) {");
    expect(out[3]).toContain(BROKEN_MARKER);
    expect(out[4]).toBe("  process.exit(78);");
    expect(out[5]).toBe("}");
    expect(out[6]).toBe("import a from 'a';");
  });
});

describe("init", () => {
  it("offers only main on the candidate, tagged with the candidate's own version", () => {
    const source = sourceRepo();
    const out = tempDir();
    const info = init({ source, out });
    const head = git(source, "rev-parse", "HEAD");
    expect(info.candidate).toBe(head);
    expect(info.candidateVersion).toBe("1.2.3");
    expect(info.latestRelease).toBe("v1.2.2");
    expect(git(info.remote, "tag", "-l")).toBe("v1.2.3");
    expect(git(info.remote, "rev-parse", "v1.2.3^{commit}")).toBe(head);
    expect(git(info.remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
      "refs/heads/main",
    );
  });

  it("keeps the real stable releases and drops everything else with --keep-releases", () => {
    const source = sourceRepo();
    const info = init({ source, out: tempDir(), keepReleases: true });
    expect(git(info.remote, "tag", "-l")).toBe("v1.2.2");
    expect(info.startRelease).toBe("v1.2.2");
  });

  it("starts an upgrade from an older release when the candidate is itself the newest one", () => {
    const source = sourceRepo();
    git(source, "tag", "v1.2.3");
    const info = init({ source, out: tempDir(), keepReleases: true });
    expect(info.latestRelease).toBe("v1.2.3");
    expect(info.startRelease).toBe("v1.2.2");
  });
});

describe("release", () => {
  it("bumps every lockstep manifest on top of main and tags it", () => {
    const { remote, candidate } = init({ source: sourceRepo(), out: tempDir() });
    const r = release({ remote, version: "1.2.4" });
    expect(r.tag).toBe("v1.2.4");
    expect(r.bumped).toBe(2);
    expect(git(remote, "rev-parse", "v1.2.4^")).toBe(candidate);
    expect(JSON.parse(show(remote, "v1.2.4", "packages/cli/package.json")).version).toBe("1.2.4");
    expect(JSON.parse(show(remote, "v1.2.4", "packages/gateway/package.json")).version).toBe(
      "1.2.4",
    );
    expect(JSON.parse(show(remote, "v1.2.4", "packages/other/package.json")).version).toBe("0.0.1");
    expect(show(remote, "v1.2.4", GATEWAY_BOOT_FILE)).not.toContain(BROKEN_MARKER);
    expect(nextVersion({ remote })).toBe("1.2.5");
    const record = JSON.parse(readFileSync(join(remote, "..", "fixture.json"), "utf8"));
    expect(record.next).toMatchObject({
      version: "1.2.4",
      tag: "v1.2.4",
      commit: r.commit,
      broken: null,
    });
  });

  it("builds a broken release on top of another release", () => {
    const { remote } = init({ source: sourceRepo(), out: tempDir() });
    const good = release({ remote, version: "1.2.4" });
    release({ remote, version: "1.2.5", base: "v1.2.4", breakKind: "gateway-boot" });
    expect(git(remote, "rev-parse", "v1.2.5^")).toBe(good.commit);
    expect(show(remote, "v1.2.5", GATEWAY_BOOT_FILE)).toContain(BROKEN_MARKER);
    expect(JSON.parse(show(remote, "v1.2.5", "packages/cli/package.json")).version).toBe("1.2.5");
  });

  it("refuses an existing tag, a malformed version and an unknown breakage", () => {
    const { remote } = init({ source: sourceRepo(), out: tempDir() });
    expect(() => release({ remote, version: "1.2.3" })).toThrow(/already exists/);
    expect(() => release({ remote, version: "1.2" })).toThrow(/not a release version/);
    expect(() => release({ remote, version: "1.2.9", breakKind: "disk" })).toThrow(
      /unknown --break/,
    );
  });

  it("numbers past a candidate whose manifest is ahead of every real tag", () => {
    const { remote } = init({ source: sourceRepo("1.3.0"), out: tempDir(), keepReleases: true });
    expect(nextVersion({ remote })).toBe("1.3.1");
  });
});

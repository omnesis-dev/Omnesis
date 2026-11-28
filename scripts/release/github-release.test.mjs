// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import {
  desktopArtifactName,
  inspectReleaseFile,
  writeDesktopArtifact,
  writeDesktopReleasePolicy,
} from "./desktop-artifacts.mjs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  attachedChecksums,
  composeReleaseNotes,
  releaseRunEvidence,
  writeReleaseFiles,
  publishDesktopGitHubRelease,
} from "./github-release.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function releaseDir(installer = "#!/bin/sh\n") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-github-release-test-")));
  dirs.push(dir);
  mkdirSync(join(dir, "artifacts"));
  writeFileSync(join(dir, "artifacts/install.sh"), installer);
  const sum = createHash("sha256").update(installer).digest("hex");
  writeFileSync(
    join(dir, "SHA256SUMS.txt"),
    `${sum}  artifacts/install.sh\n${"b".repeat(64)}  tarballs/omnesis-1.2.3.tgz\n`,
  );
  return dir;
}

test("lists the tarball sums only when the packages were published", () => {
  const sums = `${"a".repeat(64)}  artifacts/install.sh\n${"b".repeat(64)}  tarballs/x-1.2.3.tgz\n`;
  expect(attachedChecksums(sums, true)).toBe(sums);
  expect(attachedChecksums(sums, false)).toBe(`${"a".repeat(64)}  artifacts/install.sh\n`);
  expect(() => attachedChecksums(`${"b".repeat(64)}  tarballs/x.tgz\n`, false)).toThrow(
    /exactly once/u,
  );
});

test("the notes are the changelog section, then the attached checksums", () => {
  expect(composeReleaseNotes("- a change", "abc  artifacts/install.sh\n")).toBe(
    "- a change\n\n## Checksums (SHA-256)\n\n```\nabc  artifacts/install.sh\n```\n",
  );
  expect(composeReleaseNotes(null, "abc  x\n")).toMatch(/^_No changelog section/u);
});

test("writes the narrowed checksum list and the notes beside the artifacts", () => {
  const dir = releaseDir();
  const notes = writeReleaseFiles(dir, "- a change", false);
  expect(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")).not.toContain("tarballs/");
  expect(readFileSync(join(dir, "NOTES.md"), "utf8")).toBe(notes);
});

test("refuses an installer that does not match its checksum", () => {
  const dir = releaseDir();
  writeFileSync(join(dir, "artifacts/install.sh"), "#!/bin/sh\necho changed\n");
  expect(() => writeReleaseFiles(dir, "- a change", false)).toThrow(/does not match/u);
});

const job = (name, conclusion, steps = []) => ({ name, conclusion, steps });
const finished = [
  job("verify", "success"),
  job("packages", "success", [{ name: "Publish to npmjs with provenance", conclusion: "skipped" }]),
  job("images (gateway, amd64)", "success"),
  job("images (gateway, arm64)", "success"),
  job("images-manifest (gateway)", "success"),
  job("github-release", "failure"),
];

test("a run is finishable once the jobs the release page waits for succeeded", () => {
  expect(releaseRunEvidence(finished)).toEqual({ packagesPublished: false });
  // A rehearsal without image publication skips the manifest jobs.
  const rehearsal = finished.map((entry) =>
    entry.name.startsWith("images-manifest") ? { ...entry, conclusion: "skipped" } : entry,
  );
  expect(releaseRunEvidence(rehearsal).refusal).toBeUndefined();
  const published = finished.map((entry) =>
    entry.name === "packages"
      ? job("packages", "success", [
          { name: "Publish to npmjs with provenance", conclusion: "success" },
        ])
      : entry,
  );
  expect(releaseRunEvidence(published)).toEqual({ packagesPublished: true });
});

test("refuses a run whose images or manifests did not finish", () => {
  const failedImage = finished.map((entry) =>
    entry.name === "images (gateway, arm64)" ? { ...entry, conclusion: "failure" } : entry,
  );
  expect(releaseRunEvidence(failedImage).refusal).toMatch(/images jobs/u);
  const failedManifest = finished.map((entry) =>
    entry.name.startsWith("images-manifest") ? { ...entry, conclusion: "failure" } : entry,
  );
  expect(releaseRunEvidence(failedManifest).refusal).toMatch(/images-manifest/u);
  expect(releaseRunEvidence(finished.filter((entry) => entry.name !== "verify")).refusal).toMatch(
    /verify job/u,
  );
});

const desktopBinding = { version: "1.2.3", sha: "a".repeat(40) };
function desktopDir() {
  const dir = releaseDir();
  writeDesktopReleasePolicy(dir, { ...desktopBinding, enabled: true });
  for (const architecture of ["arm64", "x64"]) {
    const base = join(dir, "desktop", architecture);
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, desktopArtifactName(desktopBinding.version, architecture)),
      `invented installer ${architecture}`,
    );
    writeDesktopArtifact(base, { ...desktopBinding, architecture, notarized: true });
  }
  return dir;
}
function githubTransport(options = {}) {
  const commands = [];
  let release = options.release ?? null,
    uploads = 0,
    tagReads = 0;
  const reply = (body, status = 200) => ({
    code: status === 200 ? 0 : 1,
    stdout: `HTTP/2.0 ${status} OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`,
  });
  const gh = (args) => {
    commands.push(args);
    if (args[0] === "api" && args[1] === "graphql")
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              release: release ? { databaseId: release.id, isDraft: release.draft } : null,
            },
          },
        }),
      };
    if (args[0] === "api" && args[1] === "--include") {
      if (args[2].includes("git/ref/tags")) {
        tagReads++;
        return reply({
          object: {
            type: "commit",
            sha: options.changeTag && tagReads > 1 ? "b".repeat(40) : desktopBinding.sha,
          },
        });
      }
      if (args[2].includes("releases/tags/") && release?.draft)
        return reply({ message: "drafts are not published releases" }, 404);
      return release ? reply(release) : reply({ message: "not found" }, 404);
    }
    if (args[1] === "create") {
      expect(args).toContain("--draft");
      release = {
        id: 123,
        tag_name: "v1.2.3",
        target_commitish: desktopBinding.sha,
        prerelease: false,
        draft: true,
        assets: [],
      };
    } else if (args[1] === "upload") {
      uploads++;
      expect(release.draft).toBe(true);
      if (uploads === options.failUpload) return { code: 1, stdout: "invented-private-secret" };
      const path = args[3],
        actual = inspectReleaseFile(path);
      release.assets.push({
        name: basename(path),
        size: actual.bytes,
        digest: options.badDigest ? null : `sha256:${actual.sha256}`,
        state: "uploaded",
      });
    } else if (args[0] === "api" && args.includes("PATCH")) {
      expect(release.assets).toHaveLength(4);
      expect(args).toContain("make_latest=legacy");
      release.draft = false;
    } else throw new Error("Unexpected test transport command");
    return { code: 0, stdout: "" };
  };
  return { gh, commands, current: () => release };
}
test("desktop checksum composition survives npm-disabled releases and repeated completion", () => {
  const dir = desktopDir();
  writeReleaseFiles(dir, "- invented release", false, desktopBinding);
  writeReleaseFiles(dir, "- invented release", false, desktopBinding);
  const sums = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
  expect(sums).not.toContain("tarballs/");
  expect(sums.match(/macos-arm64.dmg/gu)).toHaveLength(1);
  expect(sums.match(/macos-x64.dmg/gu)).toHaveLength(1);
  expect(() =>
    writeReleaseFiles(dir, "- wrong", false, { ...desktopBinding, sha: "b".repeat(40) }),
  ).toThrow(/revision/);
});
test("desktop publication uploads a draft, verifies actual GitHub digests, then publishes only once", () => {
  const directory = desktopDir(),
    transport = githubTransport();
  writeReleaseFiles(directory, "- release", false, desktopBinding);
  publishDesktopGitHubRelease({ directory, ...desktopBinding, gh: transport.gh });
  expect(transport.current().draft).toBe(false);
  for (const args of transport.commands) {
    if (args[0] === "api") expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
    else expect(args[args.indexOf("--repo") + 1]).toBe("github.com/omnesis-dev/Omnesis");
  }
  expect(transport.commands.filter((args) => args[1] === "upload")).toHaveLength(4);
  expect(transport.commands.some((args) => args[1] === "graphql")).toBe(true);
  const before = transport.commands.length;
  publishDesktopGitHubRelease({ directory, ...desktopBinding, gh: transport.gh });
  expect(transport.commands.slice(before).every((args) => args[1] === "--include")).toBe(true);
});
test("a partial upload remains a draft and resumes without replacing its completed attachment", () => {
  const directory = desktopDir(),
    transport = githubTransport({ failUpload: 2 });
  writeReleaseFiles(directory, "- release", false, desktopBinding);
  expect(() =>
    publishDesktopGitHubRelease({ directory, ...desktopBinding, gh: transport.gh }),
  ).toThrow("did not complete");
  expect(transport.current().draft).toBe(true);
  expect(transport.current().assets).toHaveLength(1);
  publishDesktopGitHubRelease({ directory, ...desktopBinding, gh: transport.gh });
  expect(transport.current().draft).toBe(false);
  const uploads = transport.commands.filter((args) => args[1] === "upload");
  expect(uploads.filter((args) => args[3].endsWith("macos-arm64.dmg"))).toHaveLength(1);
  expect(uploads.every((args) => !args.includes("--clobber"))).toBe(true);
});
test.each([{ badDigest: true }, { changeTag: true }])(
  "unverified remote evidence never publishes a draft: %j",
  (options) => {
    const directory = desktopDir(),
      transport = githubTransport(options);
    writeReleaseFiles(directory, "- release", false, desktopBinding);
    expect(() =>
      publishDesktopGitHubRelease({ directory, ...desktopBinding, gh: transport.gh }),
    ).toThrow();
    expect(transport.current().draft).toBe(true);
    expect(transport.commands.some((args) => args.includes("PATCH"))).toBe(false);
  },
);
test("a published release with missing/conflicting assets cannot be reported complete or overwritten", () => {
  const directory = desktopDir(),
    transport = githubTransport({
      release: {
        id: 123,
        tag_name: "v1.2.3",
        target_commitish: desktopBinding.sha,
        prerelease: false,
        draft: false,
        assets: [],
      },
    });
  writeReleaseFiles(directory, "- release", false, desktopBinding);
  expect(() =>
    publishDesktopGitHubRelease({ directory, ...desktopBinding, gh: transport.gh }),
  ).toThrow(/attachment/);
  expect(transport.commands.every((args) => args[1] === "--include")).toBe(true);
});
test("manual completion requires both successful desktop jobs when the same-run policy enables them", () => {
  const jobs = [...finished, job("desktop (arm64)", "success"), job("desktop (x64)", "success")];
  expect(releaseRunEvidence(jobs, true).refusal).toBeUndefined();
  for (const conclusion of ["failure", "skipped", "cancelled"])
    expect(
      releaseRunEvidence(
        jobs.map((entry) => (entry.name === "desktop (x64)" ? { ...entry, conclusion } : entry)),
        true,
      ).refusal,
    ).toMatch(/desktop/);
  expect(releaseRunEvidence(finished, true).refusal).toMatch(/desktop/);
});

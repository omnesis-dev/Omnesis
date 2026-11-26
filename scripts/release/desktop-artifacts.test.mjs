// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  assertUploadedReleaseAssets,
  desktopArtifactName,
  desktopReleaseArtifacts,
  desktopReleaseEnabled,
  writeDesktopArtifact,
  writeDesktopReleasePolicy,
} from "./desktop-artifacts.mjs";
import { parseDesktopUpdateRelease } from "../../packages/cli/src/desktop/update-release.js";
const roots = [],
  binding = { version: "1.2.3", sha: "a".repeat(40) };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-release-test-")));
  roots.push(root);
  writeDesktopReleasePolicy(root, { ...binding, enabled: true });
  for (const architecture of ["arm64", "x64"]) {
    const directory = join(root, "desktop", architecture);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, desktopArtifactName(binding.version, architecture)),
      `invented-${architecture}`,
    );
    writeDesktopArtifact(directory, { ...binding, architecture, notarized: true });
  }
  return root;
}
test("desktop publication is explicitly enabled and invalid configuration cannot disable it silently", () => {
  for (const value of [undefined, "", "0"]) expect(desktopReleaseEnabled(value)).toBe(false);
  expect(desktopReleaseEnabled("1")).toBe(true);
  for (const value of ["true", "2", " 1"]) expect(() => desktopReleaseEnabled(value)).toThrow();
});
test("both actual installer byte streams produce exactly the asset names the existing updater discovers", () => {
  const assets = desktopReleaseArtifacts(fixture(), binding);
  const release = {
    draft: false,
    prerelease: false,
    tag_name: "v1.2.3",
    assets: assets.map((a) => ({
      name: a.name,
      size: a.bytes,
      digest: `sha256:${a.sha256}`,
      browser_download_url: `https://github.com/omnesis-dev/Omnesis/releases/download/v1.2.3/${a.name}`,
      state: "uploaded",
    })),
  };
  assertUploadedReleaseAssets(release, assets);
  for (const architecture of ["arm64", "x64"])
    expect(parseDesktopUpdateRelease(release, "1.2.2", architecture)?.sha256).toBe(
      assets.find((a) => a.architecture === architecture).sha256,
    );
});
test("corruption, missing architecture, extra files, wrong revision and linked metadata refuse", () => {
  let root = fixture();
  writeFileSync(
    join(root, "desktop/arm64", desktopArtifactName(binding.version, "arm64")),
    "changed",
  );
  expect(() => desktopReleaseArtifacts(root, binding)).toThrow(/checksum|size/);
  root = fixture();
  rmSync(join(root, "desktop/x64"), { recursive: true });
  expect(() => desktopReleaseArtifacts(root, binding)).toThrow();
  root = fixture();
  writeFileSync(join(root, "desktop/x64/extra"), "no");
  expect(() => desktopReleaseArtifacts(root, binding)).toThrow(/Unexpected/);
  root = fixture();
  expect(() => desktopReleaseArtifacts(root, { ...binding, sha: "b".repeat(40) })).toThrow(
    /binding|revision/,
  );
  const path = join(root, "desktop/x64/manifest.json"),
    contents = readFileSync(path);
  rmSync(path);
  writeFileSync(join(root, "other.json"), contents);
  symlinkSync("../../other.json", path);
  expect(() => desktopReleaseArtifacts(root, binding)).toThrow(/canonical/);
});
test.each([null, "sha256:" + "f".repeat(64)])(
  "missing or mismatched GitHub digest cannot publish even when the local checksum is valid: %s",
  (digest) => {
    const assets = desktopReleaseArtifacts(fixture(), binding);
    const reply = {
      assets: assets.map((a) => ({ name: a.name, size: a.bytes, state: "uploaded", digest })),
    };
    expect(() => assertUploadedReleaseAssets(reply, assets)).toThrow(/digest/);
  },
);
test("a duplicate, pending or wrong-size upload is not a completed release", () => {
  const assets = desktopReleaseArtifacts(fixture(), binding);
  const good = assets.map((a) => ({
    name: a.name,
    size: a.bytes,
    state: "uploaded",
    digest: `sha256:${a.sha256}`,
  }));
  for (const bad of [
    [good[0], good[0]],
    [{ ...good[0], state: "starter" }, good[1]],
    [{ ...good[0], size: 1 }, good[1]],
  ])
    expect(() => assertUploadedReleaseAssets({ assets: bad }, assets)).toThrow();
});
test("legacy artifacts stay headless and an explicit disabled policy does not require DMGs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-headless-test-")));
  roots.push(root);
  expect(desktopReleaseArtifacts(root, binding)).toEqual([]);
  writeDesktopReleasePolicy(root, { ...binding, enabled: false });
  expect(desktopReleaseArtifacts(root, binding)).toEqual([]);
  expect(() =>
    writeDesktopArtifact(root, { ...binding, architecture: "arm64", notarized: false }),
  ).toThrow(/notarized/);
  for (const arch of ["../arm64", "ia32"])
    expect(() => desktopArtifactName(binding.version, arch)).toThrow();
});

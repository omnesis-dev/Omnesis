// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareNodeTestFixture } from "./prepare-node-test-fixture.mjs";
import { prepareNativeNodeFixture } from "./native-check.mjs";
import { hashFile } from "./native-inventory.mjs";
import { nodeArchiveSpec } from "./node-runtime.mjs";

const roots = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-node-build-input-"));
  roots.push(root);
  const options = {
    architecture: "arm64",
    output: join(root, "fixture"),
    cache: join(root, "cache"),
  };
  const acquire = vi.fn(async () => "invented-verified-archive");
  const extract = vi.fn(async (_archive, _architecture, distribution) => {
    await mkdir(join(distribution, "bin"), { recursive: true });
    await writeFile(join(distribution, "bin/node"), "invented-self-contained-node", {
      mode: 0o755,
    });
  });
  return { root, options, acquire, extract };
}
test("fixture producer uses pinned archive provenance and verifies cached executable bytes", async () => {
  const f = await fixture();
  await prepareNodeTestFixture(f.options, f);
  const metadata = JSON.parse(await readFile(join(f.options.output, "node-fixture.json"), "utf8"));
  expect(metadata).toMatchObject({
    format: 1,
    owner: "omnesis-desktop-node-test-fixture",
    architecture: "arm64",
    archiveSha256: nodeArchiveSpec("arm64").sha256,
  });
  expect(metadata.executableSha256).toBe(await hashFile(join(f.options.output, "node")));
  await prepareNodeTestFixture(f.options, f);
  expect(f.acquire).toHaveBeenCalledOnce();
  await writeFile(join(f.options.output, "node"), "corrupt");
  await prepareNodeTestFixture(f.options, f);
  expect(f.acquire).toHaveBeenCalledTimes(2);
  expect(await readFile(join(f.options.output, "node"), "utf8")).toBe(
    "invented-self-contained-node",
  );
});
test("fixture preparation does not replace an unowned output directory", async () => {
  const f = await fixture();
  await mkdir(f.options.output);
  await writeFile(join(f.options.output, "keep"), "invented-independent-data");
  await expect(prepareNodeTestFixture(f.options, f)).rejects.toThrow();
  expect(await readFile(join(f.options.output, "keep"), "utf8")).toBe("invented-independent-data");
});
test("admitted native preflight selects the target architecture before staging source inputs", async () => {
  const f = await fixture();
  const run = vi.fn(() => ({ status: 0, stdout: "Darwin arm64\n" }));
  const prepare = vi.fn(async (options) => options.output);
  await prepareNativeNodeFixture({ host: "fixture-native-host" }, { run, prepare }, f.root);
  expect(run.mock.calls[0][0]).toBe("ssh");
  expect(run.mock.calls[0][1]).toEqual(["fixture-native-host", "uname -sm"]);
  expect(prepare).toHaveBeenCalledWith(
    expect.objectContaining({ architecture: "arm64", output: join(f.root, "macos/.node-fixture") }),
  );
  run.mockReturnValueOnce({ status: 0, stdout: "Linux x86_64\n" });
  await expect(
    prepareNativeNodeFixture({ host: "fixture-native-host" }, { run, prepare }, f.root),
  ).rejects.toThrow("macOS");
  expect(prepare).toHaveBeenCalledOnce();
});

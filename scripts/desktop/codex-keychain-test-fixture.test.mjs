// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  codexKeychainFixtureSpec,
  prepareCodexKeychainTestFixture,
} from "./prepare-codex-keychain-test-fixture.mjs";
import { prepareNativeCodexFixture } from "./native-check.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-codex-producer-fixture-"));
  roots.push(root);
  const bytes = Buffer.from("invented archive fixture bytes");
  const spec = {
    version: "0.169.0",
    architecture: "arm64",
    url: "https://example.org/fixture.tgz",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    binary: "package/vendor/fixture/codex",
  };
  const fetcher = vi.fn(async () => new Response(bytes));
  const extract = vi.fn(async (_archive, target) => {
    await mkdir(join(target, "package/vendor/fixture"), { recursive: true });
    await writeFile(join(target, spec.binary), "inert executable fixture", { mode: 0o755 });
  });
  const options = {
    architecture: "arm64",
    output: join(root, "output"),
    cache: join(root, "cache"),
  };
  const dependencies = { spec: async () => spec, fetch: fetcher, extract };
  return { root, spec, bytes, options, dependencies, fetcher, extract };
}

test("both architecture artifacts bind the pinned compatibility version to exact official npm SRI", async () => {
  for (const arch of ["arm64", "x64"]) {
    const spec = await codexKeychainFixtureSpec(arch);
    expect(spec.url).toBe(
      `https://registry.npmjs.org/@openai/codex/-/codex-${spec.version}-darwin-${arch}.tgz`,
    );
    expect(spec.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(spec.binary).toMatch(/^package\/vendor\/(aarch64|x86_64)-apple-darwin\/bin\/codex$/);
  }
  await expect(codexKeychainFixtureSpec("untrusted")).rejects.toThrow(/architecture/);
});

test("the real producer entry point parses named flags and refuses unknown architectures without downloading", async () => {
  const f = await fixture();
  const script = new URL("./prepare-codex-keychain-test-fixture.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(script), "--arch", "untrusted", "--out", f.options.output],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unsupported SDK test architecture");
});

test.skipIf(process.platform === "win32")(
  "real TAR extraction uses the reviewed 0.169 platform package bin layout",
  async () => {
    const f = await fixture();
    const distribution = join(f.root, "reviewed-layout");
    const executable = join(distribution, "package/vendor/aarch64-apple-darwin/bin/codex");
    await mkdir(join(distribution, "package/vendor/aarch64-apple-darwin/bin"), { recursive: true });
    await writeFile(executable, "inert reviewed-layout fixture", { mode: 0o755 });
    const archive = join(f.root, "reviewed-layout.tgz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", distribution, "package"], {
      encoding: "utf8",
    });
    expect(tar.status, tar.stderr).toBe(0);
    const bytes = await readFile(archive);
    const actualSpec = await codexKeychainFixtureSpec("arm64");
    await prepareCodexKeychainTestFixture(f.options, {
      spec: async () => ({
        ...actualSpec,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      }),
      fetch: async () => new Response(bytes),
    });
    expect(await readFile(join(f.options.output, "codex"), "utf8")).toBe(
      "inert reviewed-layout fixture",
    );
  },
);

test("publishes owned hashed fixture and reuses only the matching immutable executable", async () => {
  const f = await fixture();
  await prepareCodexKeychainTestFixture(f.options, f.dependencies);
  const metadata = JSON.parse(await readFile(join(f.options.output, "codex-fixture.json"), "utf8"));
  expect(metadata).toMatchObject({
    format: 1,
    owner: "omnesis-desktop-codex-keychain-test-fixture",
    integrity: f.spec.integrity,
  });
  expect(metadata.executableSha256).toBe(
    createHash("sha256").update("inert executable fixture").digest("hex"),
  );
  await prepareCodexKeychainTestFixture(f.options, f.dependencies);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.extract).toHaveBeenCalledTimes(1);
});

test("wrong archive bytes are refused before extraction or publication", async () => {
  const f = await fixture();
  f.fetcher.mockImplementation(async () => new Response("wrong fixture bytes"));
  await expect(prepareCodexKeychainTestFixture(f.options, f.dependencies)).rejects.toThrow(
    /integrity/,
  );
  expect(f.extract).not.toHaveBeenCalled();
  await expect(readFile(join(f.options.output, "codex-fixture.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a missing executable can be rebuilt only after the existing ownership marker was verified", async () => {
  const f = await fixture();
  await prepareCodexKeychainTestFixture(f.options, f.dependencies);
  await rm(join(f.options.output, "codex"));
  await prepareCodexKeychainTestFixture(f.options, f.dependencies);
  expect(await readFile(join(f.options.output, "codex"), "utf8")).toBe("inert executable fixture");
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test.skipIf(process.platform === "win32")(
  "an ownership marker alias cannot authorize deletion or replacement",
  async () => {
    const f = await fixture();
    await prepareCodexKeychainTestFixture(f.options, f.dependencies);
    const marker = join(f.options.output, "codex-fixture.json");
    const saved = join(f.root, "saved-marker.json");
    await writeFile(saved, await readFile(marker));
    await rm(marker);
    await symlink(saved, marker);
    await expect(prepareCodexKeychainTestFixture(f.options, f.dependencies)).rejects.toThrow(
      /unsafe/,
    );
    expect(await readFile(join(f.options.output, "codex"), "utf8")).toBe(
      "inert executable fixture",
    );
  },
);

test("an existing unowned folder is never removed or adopted", async () => {
  const f = await fixture();
  await mkdir(f.options.output);
  await writeFile(join(f.options.output, "keep.txt"), "unchanged fixture");
  await expect(prepareCodexKeychainTestFixture(f.options, f.dependencies)).rejects.toThrow(
    /ownership/,
  );
  expect(await readFile(join(f.options.output, "keep.txt"), "utf8")).toBe("unchanged fixture");
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "fixture output aliases are refused before touching their target",
  async () => {
    const f = await fixture();
    const target = join(f.root, "other");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "unchanged fixture");
    await symlink(target, f.options.output);
    await expect(prepareCodexKeychainTestFixture(f.options, f.dependencies)).rejects.toThrow(
      /unsafe/,
    );
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("unchanged fixture");
  },
);

test("admitted preflight prepares the selected host architecture before native test execution", async () => {
  const f = await fixture();
  const run = vi.fn(() => ({ status: 0, stdout: "Darwin x86_64\n" }));
  const prepare = vi.fn(async () => "fixture");
  await prepareNativeCodexFixture({ host: "fixture-build-host" }, { run, prepare }, f.root);
  expect(run).toHaveBeenCalledWith("ssh", ["fixture-build-host", "uname -sm"], expect.any(Object));
  expect(prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      architecture: "x64",
      output: join(f.root, "macos/.codex-keychain-fixture"),
    }),
  );
});

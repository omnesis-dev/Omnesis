// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  acquireAnalyticsSource,
  extractAnalyticsSource,
  privateBuildDirectory,
  readAnalyticsBuildPins,
} from "./analytics-sources.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(bytes = Buffer.from("invented reviewed archive")) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-analytics-input-")));
  roots.push(root);
  const pin = {
    root: "source",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://github.com/duckdb/duckdb/archive/fixture.tar.gz",
  };
  return { root, bytes, pin };
}

test("reviewed build inputs bind exact source revisions and checksums", async () => {
  const pins = await readAnalyticsBuildPins();
  expect(pins.duckdbVersion).toBe("v1.5.6");
  for (const relative of [
    "../../packages/gateway/package.json",
    "../../packages/watch/package.json",
  ]) {
    const manifest = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
    expect(manifest.dependencies["@duckdb/node-api"]).toBe(pins.nodeBindingsVersion);
  }
  expect(pins.sources.httpfs.revision).toBe("4bc690dba4496c765777a0269d48fdbaff7cdc11");
  expect(pins.sources.openssl.sha256).toHaveLength(64);
  expect(Object.keys(pins.sources)).toHaveLength(4);
});

test.skipIf(process.platform === "win32")(
  "authenticates downloaded bytes before cache publication and reuses verified inputs",
  async () => {
    const f = await fixture();
    const fetchSource = vi.fn(async () => new Response(f.bytes));
    const path = await acquireAnalyticsSource(f.pin, f.root, { fetchSource });
    expect(await readFile(path)).toEqual(f.bytes);
    expect(await readdir(f.root)).toEqual([`${f.pin.sha256}.tar.gz`]);
    expect(await acquireAnalyticsSource(f.pin, f.root, { fetchSource })).toBe(path);
    expect(fetchSource).toHaveBeenCalledOnce();
    await writeFile(path, "modified cache bytes");
    await expect(acquireAnalyticsSource(f.pin, f.root, { fetchSource })).rejects.toThrow(
      "checksum",
    );
    expect(await readFile(path, "utf8")).toBe("modified cache bytes");
    expect(fetchSource).toHaveBeenCalledOnce();
  },
);

test.skipIf(process.platform === "win32")(
  "bad checksums, cancelled downloads and insecure responses publish no archive",
  async () => {
    const f = await fixture();
    await expect(
      acquireAnalyticsSource(f.pin, f.root, {
        fetchSource: async () => new Response("not the reviewed archive"),
      }),
    ).rejects.toThrow("checksum");
    await expect(
      acquireAnalyticsSource(f.pin, f.root, {
        fetchSource: async () => ({ ok: true, url: "http://example.test/archive", body: [] }),
      }),
    ).rejects.toThrow("HTTPS");
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireAnalyticsSource(f.pin, f.root, {
        signal: controller.signal,
        fetchSource: async () => new Response(f.bytes),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(f.root)).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "refuses cache aliases and nonprivate compiler roots without following them",
  async () => {
    const f = await fixture();
    const other = await fixture();
    const cache = join(f.root, "cache");
    await symlink(other.root, cache, "dir");
    await expect(privateBuildDirectory(cache)).rejects.toThrow("private");
    const target = join(f.root, `${f.pin.sha256}.tar.gz`);
    const original = join(other.root, "unrelated");
    await writeFile(original, "unrelated data", { mode: 0o600 });
    await symlink(original, target);
    await expect(acquireAnalyticsSource(f.pin, f.root)).rejects.toMatchObject({ code: "ELOOP" });
    expect(await readFile(original, "utf8")).toBe("unrelated data");
    await chmod(f.root, 0o755);
    await expect(privateBuildDirectory(f.root)).rejects.toThrow("private");
  },
);

test.skipIf(process.platform === "win32")(
  "unsafe archive paths are refused before creating a compiler input directory",
  async () => {
    const f = await fixture();
    const archive = join(f.root, "source.tar.gz");
    await writeFile(archive, f.bytes, { mode: 0o600 });
    const run = vi.fn(() => "source/../../outside\n");
    const target = join(f.root, "extracted");
    await expect(extractAnalyticsSource(f.pin, archive, target, run)).rejects.toThrow(
      "unsafe path",
    );
    expect(run).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual(["source.tar.gz"]);
  },
);

test.skipIf(process.platform === "win32")(
  "real tar reads only reauthenticated pinned descriptors into a fresh directory",
  async () => {
    const f = await fixture();
    await mkdir(join(f.root, "source"), { mode: 0o700 });
    await writeFile(join(f.root, "source/CMakeLists.txt"), "# Invented compiler input\n");
    const archive = join(f.root, "source.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", f.root, "source"]);
    await chmod(archive, 0o600);
    const pin = {
      ...f.pin,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    };
    const target = join(f.root, "extracted");
    await extractAnalyticsSource(pin, archive, target);
    expect(await readFile(join(target, "CMakeLists.txt"), "utf8")).toBe(
      "# Invented compiler input\n",
    );
    await expect(extractAnalyticsSource(pin, archive, target)).rejects.toMatchObject({
      code: "EEXIST",
    });
    const refused = join(f.root, "refused");
    let calls = 0;
    const run = (command, args, options) => {
      const result = execFileSync(command, args, options);
      if (++calls === 1)
        execFileSync(process.execPath, [
          "-e",
          "require('fs').writeFileSync(process.argv[1], 'changed archive')",
          archive,
        ]);
      return result;
    };
    await expect(extractAnalyticsSource(pin, archive, refused, run)).rejects.toThrow(
      "changed before extraction",
    );
    expect(await readdir(refused)).toEqual([]);
    expect(calls).toBe(1);
  },
);

test("a concurrent unverified cache publication is refused and never overwritten", async () => {
  const f = await fixture();
  const target = join(f.root, `${f.pin.sha256}.tar.gz`);
  await expect(
    acquireAnalyticsSource(f.pin, f.root, {
      fetchSource: async () => {
        await writeFile(target, "concurrent unexpected bytes", { mode: 0o600 });
        return new Response(f.bytes);
      },
    }),
  ).rejects.toThrow("concurrent native source");
  expect(await readFile(target, "utf8")).toBe("concurrent unexpected bytes");
  expect(await readdir(f.root)).toEqual([`${f.pin.sha256}.tar.gz`]);
});

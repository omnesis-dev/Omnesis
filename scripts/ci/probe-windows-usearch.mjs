// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Exercise the installed binary, including old-generation reads during publication. */
export async function proveWindowsUsearch(entry, dependencyRoot, mappingProof) {
  const require = createRequire(entry);
  const build = require("node-gyp-build");
  assert.match(
    build.path(dependencyRoot).replaceAll("\\", "/"),
    /\/build\/Release\/usearch\.node$/u,
  );
  assert.equal(build(dependencyRoot).windowsPublicationVersion, 1);
  const { default: usearch } = await import(pathToFileURL(entry).href);
  const scratch = mkdtempSync(join(tmpdir(), "omnesis-vector-é-向量-"));
  const path = join(scratch, "图.usearch");
  const vector = (dimensions, coordinate) => {
    const result = new Float32Array(dimensions);
    result[coordinate] = 1;
    return result;
  };
  const index = (dimensions) =>
    new usearch.Index({
      dimensions,
      metric: usearch.MetricKind.Cos,
      quantization: usearch.ScalarKind.F32,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 64,
      multi: false,
    });
  const writer = index(32);
  const reader = index(32);
  const next = index(64);
  try {
    const mapped = spawnSync(mappingProof, [join(scratch, "large-向量.bin")], { timeout: 15_000 });
    assert.equal(mapped.error, undefined);
    assert.equal(
      mapped.status,
      0,
      `64-bit native mapping proof failed: ${mapped.stderr?.toString()}`,
    );
    writer.add(1n, vector(32, 0), 1);
    writer.save(path);
    reader.view(path);
    for (let publication = 2; publication <= 10; publication++) {
      writer.add(BigInt(publication), vector(32, publication - 1), 1);
      writer.save(`${path}.tmp`);
      usearch.atomicReplaceFile(`${path}.tmp`, path);
      // The old view stays searchable even after its pathname names the new graph.
      assert.equal(reader.size(), publication - 1);
      assert.equal(reader.search(vector(32, 0), 1, 1).keys[0], 1n);
      reader.view(path);
      assert.equal(reader.size(), publication);
      assert.equal(reader.search(vector(32, publication - 1), 1, 1).keys[0], BigInt(publication));
    }

    next.add(99n, vector(64, 40), 1);
    next.save(`${path}.tmp`);
    chmodSync(path, 0o444);
    usearch.atomicReplaceFile(`${path}.tmp`, path);
    assert.equal(reader.dimensions(), 32);
    assert.equal(reader.search(vector(32, 0), 1, 1).keys[0], 1n);
    reader.view(path);
    assert.equal(reader.dimensions(), 64);
    assert.equal(reader.search(vector(64, 40), 1, 1).keys[0], 99n);

    const directory = join(scratch, "directory");
    mkdirSync(directory);
    next.save(`${path}.tmp`);
    assert.throws(() => usearch.atomicReplaceFile(`${path}.tmp`, directory));
    assert.ok(existsSync(`${path}.tmp`));
    assert.equal(reader.search(vector(64, 40), 1, 1).keys[0], 99n);

    reader.reset();
    reader.reset();
    assert.equal(reader.size(), 0);
    rmSync(path);
    assert.equal(existsSync(path), false);
  } finally {
    reader.reset();
    writer.reset();
    next.reset();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await proveWindowsUsearch(process.argv[2], process.argv[3], process.argv[4]);
}

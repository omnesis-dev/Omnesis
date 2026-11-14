// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { embeddingServer, fetchModel, REFERENCE_MODEL } from "./with-test-embedder.mjs";

const roots = [];
const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-reference-model-"));
  roots.push(root);
  return root;
}

const binary = Buffer.from("invented model download for checksum tests");
const model = {
  ...REFERENCE_MODEL,
  file: "fixture.gguf",
  sha256: createHash("sha256").update(binary).digest("hex"),
};

test("the portable and Docker embedding lanes use the same pinned model", async () => {
  const shell = await readFile(new URL("../test-embedder.sh", import.meta.url), "utf8");
  for (const [name, value] of Object.entries({
    MODEL_ID: REFERENCE_MODEL.id,
    MODEL_REPO: REFERENCE_MODEL.repository,
    MODEL_REVISION: REFERENCE_MODEL.revision,
    MODEL_FILE: REFERENCE_MODEL.file,
    MODEL_SHA256: REFERENCE_MODEL.sha256,
  }))
    expect(shell).toContain(`${name}="${value}"`);
});

test("downloads and verifies the model, then reuses its verified cached copy", async () => {
  const root = await scratch();
  const fetchImpl = vi.fn(async () => new Response(binary));
  const path = await fetchModel(root, { model, fetchImpl });
  expect(await readFile(path)).toEqual(binary);
  expect(await fetchModel(root, { model, fetchImpl })).toBe(path);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toContain(`/resolve/${model.revision}/${model.file}`);
  expect(await readdir(root)).toEqual([model.file]);
});

test("repairs a corrupted cache and rejects an unverified replacement", async () => {
  const root = await scratch();
  await writeFile(join(root, model.file), "corrupted cache");
  await expect(
    fetchModel(root, { model, fetchImpl: async () => new Response("wrong download") }),
  ).rejects.toThrow("checksum mismatch");
  expect(await readFile(join(root, model.file), "utf8")).toBe("corrupted cache");
  expect(await readdir(root)).toEqual([model.file]);
  await fetchModel(root, { model, fetchImpl: async () => new Response(binary) });
  expect(await readFile(join(root, model.file))).toEqual(binary);
});

test("rejects failed downloads without publishing a partial model", async () => {
  const root = await scratch();
  await expect(
    fetchModel(root, { model, fetchImpl: async () => new Response("missing", { status: 404 }) }),
  ).rejects.toThrow("HTTP 404");
  expect(await readdir(root)).toEqual([]);
});

async function endpoint(embed) {
  const server = embeddingServer(embed);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("serves discovery and ordered single or batched vectors through the real HTTP protocol", async () => {
  const embed = vi.fn(async (text) => [text.length, 0.25]);
  const url = await endpoint(embed);
  expect((await (await fetch(`${url}/v1/models`)).json()).data[0].id).toBe(REFERENCE_MODEL.id);
  for (const input of ["a", ["a", "longer"]]) {
    const response = await fetch(`${url}/v1/embeddings`, {
      method: "POST",
      body: JSON.stringify({ model: REFERENCE_MODEL.id, input }),
    });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toEqual(
      (Array.isArray(input) ? input : [input]).map((text, index) => ({
        object: "embedding",
        index,
        embedding: [text.length, 0.25],
      })),
    );
  }
  expect(embed.mock.calls.map(([text]) => text)).toEqual(["a", "a", "longer"]);
});

test("rejects malformed requests and unknown models before calling the evaluator", async () => {
  const embed = vi.fn();
  const url = await endpoint(embed);
  for (const body of [
    "bad JSON",
    JSON.stringify({ model: "unknown", input: "a" }),
    JSON.stringify({ model: REFERENCE_MODEL.id, input: [7] }),
  ]) {
    expect((await fetch(`${url}/v1/embeddings`, { method: "POST", body })).status).toBe(400);
  }
  expect((await fetch(`${url}/unknown`)).status).toBe(404);
  expect(embed).not.toHaveBeenCalled();
});

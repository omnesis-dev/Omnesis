// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Run a Node check with the reference embedding model, without requiring Docker. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { waitForChild } from "../lib/check-process.mjs";

// The same model, revision and quantization as scripts/test-embedder.sh.
export const REFERENCE_MODEL = Object.freeze({
  id: "Qwen/Qwen3-Embedding-0.6B",
  repository: "Qwen/Qwen3-Embedding-0.6B-GGUF",
  revision: "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
  file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
  sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
});

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function fetchModel(cache, { model = REFERENCE_MODEL, fetchImpl = fetch } = {}) {
  await mkdir(cache, { recursive: true });
  const path = join(cache, model.file);
  try {
    if ((await digest(path)) === model.sha256) return path;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body)
      throw new Error(`Model download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
    if ((await digest(partial)) !== model.sha256)
      throw new Error("Reference model checksum mismatch");
    await rename(partial, path);
    return path;
  } finally {
    await rm(partial, { force: true });
  }
}

/** Minimal OpenAI embedding API; the embed callback is a native model in real runs. */
export function embeddingServer(embed, modelId = REFERENCE_MODEL.id) {
  return createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        send(200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/embeddings") {
        send(404, { error: "Unknown embedding endpoint" });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          send(413, { error: "Embedding input too large" });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, { error: "Expected a JSON embedding request" });
        return;
      }
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
      if (
        body?.model !== modelId ||
        inputs.length === 0 ||
        inputs.some((text) => typeof text !== "string")
      ) {
        send(400, { error: "Expected the reference model and string inputs" });
        return;
      }
      const data = [];
      for (const input of inputs) {
        data.push({ object: "embedding", index: data.length, embedding: await embed(input) });
      }
      send(200, {
        object: "list",
        model: modelId,
        data,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    } catch {
      send(500, { error: "Reference embedding failed" });
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0)
    throw new Error("Expected Node script and arguments to run with the test embedder");
  const port = Number(process.env.OMNESIS_TEST_EMBEDDER_PORT ?? 8001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid test embedder port");
  const cache =
    process.env.OMNESIS_TEST_EMBEDDER_CACHE ?? join(homedir(), ".cache", "omnesis-test-embedder");
  const modelPath = await fetchModel(cache);
  const require = createRequire(new URL("../../packages/gateway/package.json", import.meta.url));
  const { getLlama } = await import(pathToFileURL(require.resolve("node-llama-cpp")).href);
  const llama = await getLlama({ gpu: false, maxThreads: 2 });
  let model;
  let context;
  let server;
  try {
    model = await llama.loadModel({ modelPath });
    context = await model.createEmbeddingContext({
      contextSize: 8192,
      batchSize: 8192,
      threads: 2,
    });
    // One context has one evaluator. Concurrent HTTP requests queue through it.
    let pending = Promise.resolve();
    server = embeddingServer((input) => {
      const next = pending.then(async () => [...(await context.getEmbeddingFor(input)).vector]);
      pending = next.catch(() => {});
      return next;
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    // Prove native inference works before the suite starts, not just the HTTP socket.
    await context.getEmbeddingFor("readiness probe");
    process.stderr.write(`[embedder] ${REFERENCE_MODEL.id} ready on port ${port}\n`);
    return await waitForChild(
      spawn(process.execPath, args, {
        stdio: "inherit",
        detached: process.platform !== "win32",
        env: { ...process.env, OMNESIS_TEST_EMBEDDER_URL: `http://127.0.0.1:${port}` },
      }),
    );
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await context?.dispose();
    await model?.dispose();
    await llama.dispose();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

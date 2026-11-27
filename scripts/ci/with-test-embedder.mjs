// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Run a Node check with the reference embedding model, without requiring Docker. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { runCheckCommand, checkFailureMessage } from "../lib/check-process.mjs";
import { ownedProcessCleanupReceipt } from "../../packages/platform/src/owned-process-cleanup.ts";

const retainedRuntimes = new Set();
let retainedRuntimeHold;
const retainedRuntimeError = Object.assign(new Error("Embedding runtime cleanup requires review"), {
  cleanupFailure: undefined,
});
function retainRuntime(runtime) {
  retainedRuntimes.add(runtime);
  retainedRuntimeHold ??= setInterval(() => {}, 60_000);
}

// The same model, revision and quantization as scripts/test-embedder.sh.
export const REFERENCE_MODEL = Object.freeze(
  JSON.parse(readFileSync(new URL("./reference-embedder.json", import.meta.url), "utf8")),
);

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// A whole download of the reference model takes seconds on a hosted runner, so
// a transfer that delivers no bytes for this long has stalled: the connection is
// abandoned and the download starts again, instead of waiting on a socket that
// will never finish.
const DOWNLOAD_STALL_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;

class TransientDownloadError extends Error {}

/** Download `url` to `destination`, aborting when no bytes arrive for `stallMs`. */
async function downloadOnce(url, destination, { fetchImpl, stallMs }) {
  const controller = new AbortController();
  let received = 0;
  let timer;
  const watch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), stallMs);
  };
  watch();
  try {
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted)
        throw new TransientDownloadError(`no response within ${stallMs} ms`);
      const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
      throw new TransientDownloadError(`request failed: ${error?.message ?? error}${cause}`);
    }
    if (!response.ok || !response.body) {
      const message = `HTTP ${response.status}`;
      throw response.status === 429 || response.status >= 500
        ? new TransientDownloadError(message)
        : new Error(message);
    }
    const expected = Number(response.headers.get("content-length")) || undefined;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (source) {
          for await (const chunk of source) {
            received += chunk.length;
            watch();
            yield chunk;
          }
        },
        createWriteStream(destination, { flags: "wx" }),
        { signal: controller.signal },
      );
    } catch (error) {
      const progress = `${received}${expected ? ` of ${expected}` : ""} bytes`;
      if (controller.signal.aborted)
        throw new TransientDownloadError(`no data for ${stallMs} ms after ${progress}`);
      throw new TransientDownloadError(`transfer failed after ${progress}: ${error.message}`);
    }
    return received;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchModel(
  cache,
  {
    model = REFERENCE_MODEL,
    fetchImpl = fetch,
    stallMs = DOWNLOAD_STALL_MS,
    attempts = DOWNLOAD_ATTEMPTS,
    retryDelayMs = 2_000,
    writeStderr = (text) => process.stderr.write(text),
  } = {},
) {
  await mkdir(cache, { recursive: true });
  const path = join(cache, model.file);
  try {
    if ((await digest(path)) === model.sha256) return path;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file}`;
  for (let attempt = 1; ; attempt++) {
    const partial = `${path}.${randomUUID()}.partial`;
    const started = Date.now();
    try {
      const bytes = await downloadOnce(url, partial, { fetchImpl, stallMs });
      if ((await digest(partial)) !== model.sha256)
        throw new Error("Reference model checksum mismatch");
      await rename(partial, path);
      writeStderr(
        `[embedder] downloaded ${model.file}: ${bytes} bytes in ${Date.now() - started} ms\n`,
      );
      return path;
    } catch (error) {
      const reason = `Reference model download from ${url}, attempt ${attempt} of ${attempts}: ${error.message}`;
      if (!(error instanceof TransientDownloadError) || attempt >= attempts)
        throw new Error(reason, { cause: error });
      writeStderr(`[embedder] ${reason}; retrying\n`);
    } finally {
      await rm(partial, { force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
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
  if (retainedRuntimes.size) throw retainedRuntimeError;
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
  return runWithEmbeddingRuntime(args, { modelPath, port, llama, disposeModel: false });
}

/**
 * End this process without freeing the native model. On a Windows host whose CPU has
 * AMX, llama.cpp keeps the model weights in a buffer it allocates with
 * `_aligned_malloc` and frees with `free`, so freeing the model aborts the process with
 * STATUS_HEAP_CORRUPTION (0xC0000374) after the check has already passed. The process
 * is ending, so the operating system reclaims the model instead. `process.exit` also
 * skips node-llama-cpp's own `beforeExit` disposal, which would free it the same way.
 */
export async function exitWithoutModelTeardown(
  code,
  { exit = (status) => process.exit(status), streams = [process.stdout, process.stderr] } = {},
) {
  await Promise.all(streams.map((stream) => new Promise((resolve) => stream.write("", resolve))));
  exit(code);
}

/** Keep embedding resources alive until the owned check has confirmed its cleanup. */
export async function runWithEmbeddingRuntime(
  args,
  {
    modelPath,
    port,
    llama,
    retainUnconfirmed = retainRuntime,
    writeStderr = (text) => process.stderr.write(text),
    // The process entry leaves the model to process exit; see exitWithoutModelTeardown.
    disposeModel = true,
  },
  run = runCheckCommand,
) {
  if (retainedRuntimes.size) throw retainedRuntimeError;
  let model;
  let context;
  let server;
  let cleanupUnconfirmed = false;
  let failed = false;
  let failure;
  let exitCode;
  const cleanupErrors = [];
  const retain = () => {
    cleanupUnconfirmed = true;
    retainUnconfirmed({ server, context, model, llama });
  };
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
    const boundPort = server.address().port;
    process.stderr.write(`[embedder] ${REFERENCE_MODEL.id} ready on port ${boundPort}\n`);
    exitCode = await run(process.execPath, args, {
      env: {
        ...process.env,
        OMNESIS_TEST_EMBEDDER_URL: `http://127.0.0.1:${boundPort}`,
        OMNESIS_TEST_EMBEDDER_MODEL_PATH: modelPath,
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
    if (ownedProcessCleanupReceipt(error) !== undefined) retain();
  } finally {
    if (!cleanupUnconfirmed) {
      for (const cleanup of [
        async () => {
          if (server?.listening) {
            server.closeAllConnections();
            await new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
        () => context?.dispose(),
        ...(disposeModel ? [() => model?.dispose(), () => llama.dispose()] : []),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
          if (ownedProcessCleanupReceipt(error) !== undefined) {
            retain();
            break;
          }
        }
      }
    }
  }
  if (cleanupErrors.length) {
    const reasons = [...(failed ? [failure] : []), ...cleanupErrors];
    const marked = reasons.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
    const receipt = ownedProcessCleanupReceipt(marked);
    const error = new AggregateError(reasons, "Embedding runtime cleanup failed", {
      cause: receipt === undefined ? cleanupErrors[0] : marked,
    });
    if (receipt !== undefined) Object.assign(error, { cleanupFailure: receipt.failure });
    throw error;
  }
  if (failed) throw failure;
  // The wrapped check's status crosses a Windows job without a message; name it
  // here, so a non-zero status after a passing check shows which level set it.
  if (exitCode !== 0) writeStderr(`[embedder] ${basename(args[0])} exited ${exitCode}\n`);
  return exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${checkFailureMessage(error)}\n`);
    process.exitCode = 1;
  }
  // Retained resources deliberately keep the process alive for review.
  if (retainedRuntimes.size === 0) await exitWithoutModelTeardown(process.exitCode);
}

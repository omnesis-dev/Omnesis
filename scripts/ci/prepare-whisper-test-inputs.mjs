// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Configure actual native ASR for the complete Windows unit lane. */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getCatalogEntry } from "../../packages/core/src/models/catalog.ts";
import { isEntryScript } from "../lib/is-entry-script.mjs";

const tiny = getCatalogEntry("whisper-tiny");
if (!tiny || tiny.kind !== "gguf" || !tiny.sha256)
  throw new Error("Missing pinned Whisper Tiny model");
export const WHISPER_TEST_ASSETS = Object.freeze([
  Object.freeze({
    variable: "OMNESIS_WHISPER_TEST_MODEL",
    filename: "tiny model.bin",
    url: tiny.downloadUrl,
    sizeBytes: tiny.sizeBytes,
    sha256: tiny.sha256,
  }),
  Object.freeze({
    variable: "OMNESIS_WHISPER_TEST_AUDIO",
    filename: "public sample.wav",
    url: "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.7.6/samples/jfk.wav",
    sizeBytes: 352_078,
    sha256: "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
  }),
]);

/** An error a later attempt may not meet: the host or the network failed, not the asset. */
function transient(error) {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), {
    transient: true,
  });
}

/** Bound streamed downloads and publish no unverified input to the tests. */
export async function downloadWhisperTestAsset(asset, path, { fetchImpl = fetch } = {}) {
  const digest = createHash("sha256");
  let bytes = 0;
  let created = false;
  try {
    const host = new URL(asset.url).host;
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(180_000) }).catch(
      (error) => {
        throw transient(new Error(`ASR asset from ${host}: ${error?.message ?? error}`));
      },
    );
    if (!response.ok || !response.body) {
      const error = new Error(`ASR asset HTTP ${response.status} from ${host}`);
      throw [408, 429].includes(response.status) || response.status >= 500
        ? transient(error)
        : error;
    }
    const destination = createWriteStream(path, { flags: "wx" });
    destination.once("open", () => {
      created = true;
    });
    let oversize;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > asset.sizeBytes)
              return callback((oversize = new Error("ASR asset exceeds pinned size")));
            digest.update(chunk);
            callback(null, chunk);
          },
        }),
        destination,
      );
    } catch (error) {
      // An oversize body or a path that already exists is the asset's own
      // failure; anything else while streaming is the connection's.
      if (error === oversize || error?.code === "EEXIST") throw error;
      throw transient(new Error(`ASR asset from ${host} broke off: ${error?.message ?? error}`));
    }
    if (bytes !== asset.sizeBytes || digest.digest("hex") !== asset.sha256)
      throw new Error("ASR asset checksum or size mismatch");
    return path;
  } catch (error) {
    if (created) await rm(path, { force: true });
    throw error;
  }
}

/**
 * Download an asset, trying again while its host or the network fails
 * transiently (a 5xx, 408 or 429 answer, a refused or broken connection).
 * A missing asset, a size or checksum mismatch, or an existing path fails at once.
 */
export async function downloadWhisperTestAssetWithRetry(
  asset,
  path,
  { fetchImpl = fetch, waitsMs = [5_000, 10_000, 20_000, 40_000], sleep = defaultSleep } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadWhisperTestAsset(asset, path, { fetchImpl });
    } catch (error) {
      if (!error?.transient || attempt >= waitsMs.length) throw error;
      console.warn(
        `${error.message}; trying again in ${waitsMs[attempt] / 1000} s (attempt ${attempt + 2} of ${waitsMs.length + 1})`,
      );
      await sleep(waitsMs[attempt]);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function prepareWhisperTestInputs() {
  if (!process.env.GITHUB_ENV) throw new Error("Native ASR CI requires GITHUB_ENV");
  // Resolve exactly what the real worker loads; optional install failure must
  // fail this lane rather than turn native inference into skipped tests.
  const requireGateway = createRequire(
    new URL("../../packages/gateway/package.json", import.meta.url),
  );
  if (typeof requireGateway("smart-whisper").Whisper !== "function")
    throw new Error("Missing actual Whisper constructor");
  const ffmpeg = requireGateway("ffmpeg-static");
  if (typeof ffmpeg !== "string" || !existsSync(ffmpeg))
    throw new Error("Missing actual ffmpeg executable");
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "native ASR inputs-"));
  const variables = [];
  for (const asset of WHISPER_TEST_ASSETS) {
    const path = await downloadWhisperTestAssetWithRetry(asset, join(directory, asset.filename));
    variables.push(`${asset.variable}=${path}`);
  }
  variables.push(`OMNESIS_WHISPER_TEST_FFMPEG=${ffmpeg}`);
  // Publish the complete set together: a failed asset never configures a
  // partial acceptance run. Inputs stay for the hosted job's full lifetime.
  await appendFile(process.env.GITHUB_ENV, variables.join("\n") + "\n");
}

if (isEntryScript(import.meta.url)) await prepareWhisperTestInputs();

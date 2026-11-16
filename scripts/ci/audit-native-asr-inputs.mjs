// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Load the exact binding that the real worker resolves. Optional install
// failure is an acceptance failure, never a skipped native test.
const requireGateway = createRequire(
  new URL("../../packages/gateway/package.json", import.meta.url),
);
const binding = requireGateway("smart-whisper");
if (typeof binding.Whisper !== "function") throw new Error("Missing actual Whisper constructor");
const ffmpeg = requireGateway("ffmpeg-static");
if (typeof ffmpeg !== "string" || !existsSync(ffmpeg))
  throw new Error("Missing actual ffmpeg executable");
const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "native ASR inputs-"));
async function download(name, url, size, sha256) {
  const path = join(directory, name);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Asset HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > size) return callback(new Error("Asset exceeds pinned size"));
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(path, { flags: "wx" }),
    );
    if (bytes !== size || digest.digest("hex") !== sha256)
      throw new Error("Asset checksum mismatch");
    return path;
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}
// Match the model already pinned in the public Omnesis catalog. The sample
// comes from the pinned upstream whisper.cpp tag; no operator recording is used.
const model = await download(
  "tiny model.bin",
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  77_691_713,
  "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
);
const audio = await download(
  "public sample.wav",
  "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.7.6/samples/jfk.wav",
  352_078,
  "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
);
if (!process.env.GITHUB_ENV) throw new Error("Hosted acceptance requires GITHUB_ENV");
await appendFile(
  process.env.GITHUB_ENV,
  `OMNESIS_WHISPER_TEST_MODEL=${model}\nOMNESIS_WHISPER_TEST_AUDIO=${audio}\nOMNESIS_WHISPER_TEST_FFMPEG=${ffmpeg}\n`,
);

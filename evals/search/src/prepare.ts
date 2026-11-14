// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run search-eval:prepare` — download the public MIRACL development split
 * and build one bounded document pool per language.
 *
 * MIRACL is Wikipedia passages in 18 languages with questions written by native
 * speakers and human relevance judgments. Its full corpus is about 90 million
 * passages, so each language's pool holds every judged passage of every
 * development query plus a deterministic uniform sample of the rest of that
 * language's corpus, up to `--pool-size` passages. Every judged passage is in
 * the pool, so the pool is easier than the full corpus: scores are comparable
 * between runs over the same pools and with nothing else.
 *
 * The sample keeps the passages whose id hashes lowest, so it is the same on
 * every machine and independent of download order. Both upstream datasets are
 * pinned to a commit. Nothing downloaded is written inside the repository.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import {
  defaultDataDir,
  languageDir,
  parseLanguages,
  type DatasetManifest,
  type Language,
  type LanguageManifest,
  type Passage,
} from "./dataset.js";

const HUB = "https://huggingface.co";
const TOPICS_REPO = "miracl/miracl";
const TOPICS_REVISION = "5be20db9509754dadad47689368639fcec739c00";
const CORPUS_REPO = "miracl/miracl-corpus";
const CORPUS_REVISION = "d921ec7e349ce0d28daf30b2da9da5ee698bef0d";

const DEFAULT_POOL_SIZE = 100_000;
/** Corpus shards downloaded at once. */
const SHARD_CONCURRENCY = 4;

const USAGE =
  "usage: search-eval:prepare -- [--data-dir <dir>] [--languages ar,ko,…] [--pool-size N] [--force]";

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function fetchOk(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.ok && res.body) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function resolveUrl(repo: string, revision: string, path: string): string {
  return `${HUB}/datasets/${repo}/resolve/${revision}/${path}`;
}

async function listShards(language: Language): Promise<string[]> {
  const dir = `miracl-corpus-v1.0-${language}`;
  const res = await fetchOk(`${HUB}/api/datasets/${CORPUS_REPO}/tree/${CORPUS_REVISION}/${dir}`);
  // A pool sampled from part of a corpus would be silently biased.
  if (res.headers.get("link")?.includes('rel="next"')) {
    throw new Error(`The shard listing for ${language} is paginated; refusing a partial corpus`);
  }
  const entries = (await res.json()) as Array<{ path: string; type: string }>;
  return entries
    .filter((e) => e.type === "file" && e.path.endsWith(".jsonl.gz"))
    .map((e) => e.path)
    .sort();
}

/** Lower sorts first; the pool keeps the lowest. */
function sampleKey(docid: string): string {
  return createHash("sha256").update(docid).digest("hex").slice(0, 16);
}

interface Sampled {
  key: string;
  passage: Passage;
}

async function readShard(path: string, onPassage: (passage: Passage) => void): Promise<void> {
  const res = await fetchOk(resolveUrl(CORPUS_REPO, CORPUS_REVISION, path));
  const gunzip = createGunzip();
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("error", (err) => gunzip.destroy(err));
  // Split on "\n" only: passages contain U+2028, which `readline` treats as a
  // line break.
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body.pipe(gunzip) as AsyncIterable<Buffer>) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line) onPassage(JSON.parse(line) as Passage);
    }
  }
  if (rest) onPassage(JSON.parse(rest) as Passage);
}

async function prepareLanguage(
  dataDir: string,
  language: Language,
  poolSize: number,
): Promise<LanguageManifest> {
  const base = `miracl-v1.0-${language}`;
  const [topics, qrels] = await Promise.all(
    [`topics/topics.${base}-dev.tsv`, `qrels/qrels.${base}-dev.tsv`].map(async (path) =>
      (await fetchOk(resolveUrl(TOPICS_REPO, TOPICS_REVISION, `${base}/${path}`))).text(),
    ),
  );
  const qrelLines = qrels!.split("\n").filter(Boolean);
  const judgedIds = new Set(qrelLines.map((line) => line.split("\t")[2]!));
  const queryLines = topics!.split("\n").filter(Boolean);

  const judged = new Map<string, Passage>();
  const sampled: Sampled[] = [];
  let corpusPassages = 0;
  const backgroundTarget = Math.max(0, poolSize - judgedIds.size);
  const trim = (): void => {
    sampled.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    sampled.length = Math.min(sampled.length, backgroundTarget);
  };

  const shards = await listShards(language);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < shards.length) {
      const shard = shards[next]!;
      next += 1;
      await readShard(shard, (passage) => {
        corpusPassages += 1;
        if (judgedIds.has(passage.docid)) {
          judged.set(passage.docid, passage);
          return;
        }
        if (backgroundTarget === 0) return;
        sampled.push({ key: sampleKey(passage.docid), passage });
        if (sampled.length >= backgroundTarget * 2 + 1024) trim();
      });
      done += 1;
      say(`  ${language}: shard ${done}/${shards.length}`);
    }
  };
  await Promise.all(Array.from({ length: SHARD_CONCURRENCY }, worker));
  trim();

  // Judged first, then the sample, each in a stable order.
  const pool = [
    ...[...judged.values()].sort((a, b) => (a.docid < b.docid ? -1 : 1)),
    ...sampled.map((s) => s.passage),
  ];

  const dir = languageDir(dataDir, language);
  mkdirSync(dir, { recursive: true });
  const corpusHash = createHash("sha256");
  const corpusTmp = join(dir, "corpus.jsonl.tmp");
  const out = createWriteStream(corpusTmp);
  for (const passage of pool) {
    const line = `${JSON.stringify({ docid: passage.docid, title: passage.title, text: passage.text })}\n`;
    corpusHash.update(line);
    if (!out.write(line)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  out.end();
  await finished(out);
  await rename(corpusTmp, join(dir, "corpus.jsonl"));

  const queriesText = `${queryLines.join("\n")}\n`;
  const qrelsText = `${qrelLines.join("\n")}\n`;
  writeFileSync(join(dir, "queries.tsv"), queriesText);
  writeFileSync(join(dir, "qrels.tsv"), qrelsText);
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  const manifest: LanguageManifest = {
    language,
    passages: pool.length,
    judgedPassages: judged.size,
    missingJudgedPassages: judgedIds.size - judged.size,
    corpusPassages,
    queries: queryLines.length,
    judgments: qrelLines.length,
    sha256: { corpus: corpusHash.digest("hex"), queries: sha(queriesText), qrels: sha(qrelsText) },
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--force") {
      force = true;
      continue;
    }
    const value = argv[i + 1];
    if (!["--data-dir", "--languages", "--pool-size"].includes(flag) || value === undefined) {
      throw new Error(`Unknown or incomplete argument "${flag}".\n${USAGE}`);
    }
    flags.set(flag, value);
    i += 1;
  }
  const dataDir = flags.get("--data-dir") ?? defaultDataDir();
  const languages = parseLanguages(flags.get("--languages"));
  const poolSize = Number(flags.get("--pool-size") ?? DEFAULT_POOL_SIZE);
  if (!Number.isInteger(poolSize) || poolSize < 1) throw new Error(USAGE);
  mkdirSync(dataDir, { recursive: true });

  const manifestPath = join(dataDir, "manifest.json");
  const previous: DatasetManifest | null = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as DatasetManifest)
    : null;
  const reusable =
    !force &&
    previous?.poolSize === poolSize &&
    previous.revisions.topics === TOPICS_REVISION &&
    previous.revisions.corpus === CORPUS_REVISION;
  const byLanguage = new Map<Language, LanguageManifest>(
    reusable ? previous.languages.map((l) => [l.language, l]) : [],
  );

  for (const language of languages) {
    if (byLanguage.has(language)) {
      say(`${language}: already prepared, skipping`);
      continue;
    }
    say(`${language}: downloading`);
    const entry = await prepareLanguage(dataDir, language, poolSize);
    byLanguage.set(language, entry);
    say(
      `${language}: ${entry.passages} passages (${entry.judgedPassages} judged, ` +
        `${entry.missingJudgedPassages} judged ids missing upstream) from a corpus of ` +
        `${entry.corpusPassages}; ${entry.queries} queries`,
    );
    const manifest: DatasetManifest = {
      dataset: "miracl-dev-pools",
      poolSize,
      revisions: { topics: TOPICS_REVISION, corpus: CORPUS_REVISION },
      languages: [...byLanguage.values()].sort((a, b) => (a.language < b.language ? -1 : 1)),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  say(`Dataset ready at ${dataDir}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

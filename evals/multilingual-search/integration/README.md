# Combined SQLite integration prototype

These scripts exercise the actual encrypted gateway database and memory ranker
in isolated throwaway stores. They do not wire production HTTP search, change
the default tokenizer, or use any live service or user configuration.

## Components

- `store.mjs` registers the native extension and builds an external-content FTS5
  index over an ordinary raw-text table and a locale-bearing view. It provides
  resumable subsequent index generations, dual writes, validation, activation,
  retained rollback, discard and retirement.
- `query.mjs` compiles native analysis into an escaped query representation and
  executes it through SQLite or the generic memory-ranker `rankTerms` entry
  point. A reserved query-only locale passes compiled terms through unchanged.
  Query/index fingerprints and generation epochs are checked within the same
  read snapshot as cache following and result assembly.
  Ordinary queries use unique OR terms, matching the public quality protocol;
  intentional phrases retain repeated terms and their order.
- `verify.mjs` checks lifecycle, encryption, offsets, query escaping,
  restrictions, updates, workers, reopening and generation behavior.
- `parity.mjs` checks token/offset/query round trips over the fixed 30-language
  controls. Compare stream and recipe hashes across platforms; a token round
  trip proves consistency, not linguistic relevance.
- `concurrency.mjs` checks old/new/rollback observations from an independent
  reader while the writer backfills and changes documents. This is a controlled
  small soak, not a production contention benchmark.
- `scale.mjs` measures independent encrypted processes at increasing mixed
  public-corpus sizes, including fresh-process reopen, warm queries, memory,
  writes and restrictive queries. `prepare-scale.py` prepares the deterministic
  workload from audited public pools. Required positives are retained in each
  smaller prefix; the workload is not a random sample of personal documents.
- `jsonl.mjs` reads LF-delimited records without treating valid Unicode line or
  paragraph separators inside JSON strings as record boundaries.

## Running the native proof

Use the host's normal admission mechanism for heavy builds/checks. Keep the
Cargo target, inputs, reports, indexes, tools and downloaded models outside Git.
The hosted research workflow demonstrates the complete reproducible commands.

```sh
export CARGO_TARGET_DIR=/tmp/multilingual-native-target
sh evals/multilingual-search/prototype/build-native.sh \
  node_modules/better-sqlite3/deps/sqlite3
mkdir -p /tmp/multilingual-native-reports
node --import tsx evals/multilingual-search/integration/verify.mjs \
  "$CARGO_TARGET_DIR/release/libomnesis_multilingual.so" \
  /tmp/multilingual-native-reports/native.json
node --import tsx evals/multilingual-search/integration/parity.mjs \
  "$CARGO_TARGET_DIR/release/libomnesis_multilingual.so" \
  /tmp/multilingual-native-reports/parity.json
node --import tsx evals/multilingual-search/integration/concurrency.mjs \
  "$CARGO_TARGET_DIR/release/libomnesis_multilingual.so" \
  /tmp/multilingual-native-reports/concurrency.json
node --test evals/multilingual-search/integration/jsonl.test.mjs
```

Use `.dylib` instead of `.so` on macOS. Every SQLite process/worker must register
its own tokenizer before reading the derived index. The locale-aware prototype
requires SQLite 3.47 or newer; the measured gateway build is SQLite 3.53.4.
The fallback tokenizer API for older SQLite does not provide the equivalent
per-value language-hint/query-pass-through contract.

## Deliberate boundaries

The first `installPrototype` call replaces the isolated legacy FTS index and
rebuilds within one immediate transaction. It is an offline research installer,
not a proven bounded first migration from a populated production Porter index.
The resumable mechanism proves subsequent native exact/stem generation changes.
Production startup currently expects its configured legacy tokenizer, so the
research store must reopen through this adapter rather than the normal startup
migration path.

The research language column and direct writer helpers are not production
schema or writer-queue integration. Backfill batch sizes and query bounds are
fixed research parameters. Product scheduling, configuration, crash recovery,
release packaging and first migration remain explicit implementation work.

The memory ranker lacks phrase positions and falls back for intentional
phrases. Its incremental term statistics retain the production implementation's
approximation until the next cache build; operational reports record observed
post-update candidate-order differences. Candidate restrictions and pending
source visibility use production helpers and apply before result limiting.

Native `exact` means normalized segmented surface terms without Snowball. It
is not byte-literal matching or an unsplit-compound guarantee. Literal codes,
URLs, alternative compound graphs and a production surface/stem ranking policy
need their own representation and acceptance checks.

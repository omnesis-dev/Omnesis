<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Held-out multilingual lexical retrieval study

This is an offline research benchmark. It changes no search defaults. The frozen
[policy](policy.json) was written before computing any retrieval scores in this
track. It specifies all samples, methods, matching modes, fusion, development-only
acceptance calibration, and paired uncertainty. Its exact-byte SHA256 is
`241976bc687be9716539efff7fa22666ad4f4cfeb46c8457ad84f1b1edac6589`.

The dataset cards declare Apache 2.0. Wikipedia-derived passage text remains
external and is not redistributed in these source files or reports. Cite the
upstream dataset/paper and retain their notices when redistributing any data.

The public [NoMIRACL release](https://huggingface.co/datasets/miracl/nomiracl)
publishes human 0/1 judgments and passage text in all 18 MIRACL languages.
A pre-score [integrity amendment](amendment-2026-11-13.json) excludes Yoruba
from the primary held-out macro: its relevant qrels have foreign/mismatched IDs
and extra conflicting labels. Chinese legacy IDs are repaired mechanically,
validated against every one of its 393 official development query judgment
dictionaries; missing selected text is recovered from the pinned official
corpus. The resulting independent primary track covers **17 languages**, with
4,250 relevant and 4,091 no-known-positive held-out test queries. Original intended
coverage of 18 languages remains recorded in the immutable policy. Its
relevant development queries come from MIRACL development; relevant held-out test
queries come from MIRACL TEST-B, separately from the earlier NanoMIRACL study.
The [paper](https://aclanthology.org/2024.findings-emnlp.730/) describes the official
disjoint splits and the original judged candidate construction. All original
explicit negatives and multiple positives are retained, rather than assuming one
positive passage per query.

`prepare.py` pins dataset commits and verifies each downloaded file against its
upstream SHA256 or Git blob ID. It chooses up to 100 development and 250 test
queries **per language and relevance subset**, by deterministic query-ID hash.
Every judged passage is retained at both corpus sizes. Deterministically chosen
[official MIRACL corpus](https://huggingface.co/datasets/miracl/miracl-corpus)
shards add hash-sampled distractors to reach nested 10,000 and 100,000 document
pools. If a language's available corpus is smaller, the actual count is reported.

These are **judgment-augmented bounded-shard pools**, not official full-corpus
MIRACL results. All judgments for the selected queries are in the pool, while
background outside the chosen shards is absent. Shards may have topic clusters;
selection by shard hash is not a uniform sample from the full corpus. Published
NoMIRACL candidates also reflect their original retrieval systems. A judged
passage version takes precedence over a different version with the same public
ID; conflicts are counted. Pool construction uses labels, identically for all
methods, and intentionally makes the benchmark less pessimistic than full-corpus
retrieval. Reading these scores as production quality or full-MIRACL scores would
be incorrect.

NoMIRACL's non-relevant subset has no relevant passage among its originally judged
candidates. An added background passage can be relevant but unjudged. Reports
therefore separate explicit-negative, unjudged and missing top results, and call
threshold acceptance **apparent false acceptance on no-known-positive queries**.
Thresholds maximize balanced accuracy using development queries only, separately
for each language/method/corpus size. Raw BM25 values are never compared across
languages. No global claim of answerability or irrelevance follows from this test.

## Reproduce

Use Python 3.11+, `snowballstemmer==3.1.1`, a C compiler, SQLite development headers, and SQLite with FTS5/loadable
extension support. Build the pinned ICU4X, full/lean Charabia and prototype probes
from their neighboring directories. Do not put downloaded text or caches in Git.

```sh
python3 evals/multilingual-search/extended-public/prepare.py \
  --data-dir "$EXTERNAL_DATA" --languages de
python3 evals/multilingual-search/extended-public/test_method.py
python3 evals/multilingual-search/extended-public/evaluate.py \
  --data-dir "$EXTERNAL_DATA" --cache-dir "$EXTERNAL_CACHE" \
  --output "$EXTERNAL_RESULTS/de.json" --languages de --sizes 10000 100000 \
  --icu4x "$ICU4X_PROBE" --charabia-full "$FULL_PROBE" \
  --charabia-lean "$LEAN_PROBE" --prototype "$PROTOTYPE_PROBE"
```

The heavy evaluator belongs in the host's normal admitted job queue. CI may run
one independent process per eligible language, with separate caches and result paths.
`prepare.py` defaults to the 17 eligible languages and explicitly rejects an
excluded language. Both scripts record the amendment hash.
Merge all language reports using `aggregate.py --reports REPORTS... --output SUMMARY`;
it requires both corpus sizes and every eligible language, rejects mismatched
source/policy revisions, and computes equal-weight language macros with paired
query resampling within each language. Intervals are not multiplicity adjusted.
`run-matrix.py` accepts the same binary/data/cache options, `--output-dir`
and `--workers` (one to three, default three). It joins one evaluator per language,
keeps external per-language logs, and invokes the strict aggregator only after
every eligible language succeeds. A language subset runs without producing a
primary aggregate. Optional `--prune-successful-cache` removes only recognized
owned cache files inside that completed language’s cache directory after a
successful evaluator run; it leaves data/manifests/reports and unknown files
alone. This bounds disk use when running the full matrix on a CI runner.
Language selection can be parallelized; one process analyzes its engines
sequentially. All requested corpus sizes reuse maximal document-analysis caches.
The analyzer process reads and writes files, avoiding pipe deadlocks and an
additional complete in-memory token response. Indexes are local scratch FTS5
stores and preserve no user data. Source, data, binary and policy hashes identify
caches and reports.

Every candidate receives the known monolingual dataset language. This is an
analysis benchmark, **not automatic language detection or mixed-language routing**.
Current porter keeps its existing mark-dropping query sanitizer. Other OR methods
use individual analyzed terms, AND requires all unique terms, MSM60 requires at
least 60% rounded up, and explicit whole-input quotes use a phrase. A tiny FTS5
auxiliary function counts matched unique clauses exactly; MSM is not a post-filter
of a truncated OR ranking. Title/content BM25 weights are 2/1 for every method.

The precise original surface lane uses the prototype's segmented NFKC/lowercase
surfaces. Its BM25 scores are never added to stem-lane BM25 scores: the fixed
alternatives are reciprocal rank fusion (k=60, 1000 candidates per lane) and a
deterministic phrase/all-original-terms/stem tier over those bounded candidate
lists, with stem rank as a tie-break. This does not promise a globally exact tier
order beyond the fixed candidate depth.
Ranking quality is reported on relevant queries; acceptance and top-score
distributions use the separate no-known-positive subset. Paired query bootstrap
intervals accompany method differences. Development results and test results
remain separate. No choice is optimized on test scores.

Reports contain only public query IDs, counts, metrics, score distributions,
hashes and timing metadata. Source text remains external. Wall times include
process startup and are research measurements, not a production latency promise.
Cached timings are marked and must not be summed as new elapsed work. SQLite and
its FTS5 implementation are the offline Python build recorded in every report,
not the gateway's encrypted SQLite/native adapter.

## Optional predeclared supplements

A separate [supplemental protocol](supplemental-policy.json), frozen before
held-out outputs, keeps the original nine-method primary study unchanged.
`--stopwords FILE` accepts the external Lucene 9.12.3 export with a top-level
`version` and `languages`, each language carrying `words`, `status`, and
`analyzer`. Query tokens are removed only when their normalized **surface** is a
single-token normalized stopword. Stems are not used to decide removal. Quoted
phrases stay intact; an otherwise empty query falls back to its original terms.
The alternatives are native OR, query-stopword OR, and query-stopword MSM60 on
the identical stem index. POS-based stop filtering is outside this word-list
ablation. Reports include availability, normalization and per-query removal
counts, without the stopword or query strings.

`--simplemma` requires `simplemma==2.0.0` and adds a separate 10k dictionary-lemma
lane for its 11 predeclared supported languages. It consumes the existing
prototype exact-token cache, preserves one token per position, and leaves
unsupported languages explicit. Compare native stem OR, lemma OR, and fixed
RRF(stem, lemma). The optional lemma aggregate covers only those same 11
languages and must not be compared to the 17-language primary macro as though
the cohorts were identical.

Both flags work with `evaluate.py` and `run-matrix.py`, before any successful
cache pruning. The strict aggregator writes supplemental results separately
as `summary-supplemental.json` alongside the primary `summary.json`.
`--supplemental-only` instead computes only prototype stem/surface analyses,
native OR and the requested supplements; it skips the other analyzer/ranking
runs and produces a separate supplemental summary, without claiming a new
primary nine-method result. Its reports cannot be mixed with primary reports.
The shared frozen queries, judgment-augmented corpora, development-only
calibration, and paired bootstrap policy all remain in force. No parameter is
selected on held-out results.

In `--supplemental-only` mode, only `--prototype` is required; the ICU/full/lean
binary flags may be omitted. The supplemental matrix can therefore use one
small native build without rebuilding the baseline analyzer packages.

After both independent runs finish, `verify-baseline.py --primary-dir DIR
--supplemental-dir DIR --output REPORT` checks the identical policy/amendment,
SQLite version, complete document/query/pool hashes, native semantic fingerprint,
and every query's native baseline metrics, top-result judgment and result count.
Top scores must also agree within a small floating-point tolerance. This permits
a separately rebuilt supplemental run to prove that its baseline reproduces the
original primary run. It never changes either run's results.

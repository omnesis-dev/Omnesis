# Multilingual lexical search investigation

The expanded prototype and independent study are described in
[PLAN.md](PLAN.md), [the combined integration](integration/README.md),
[the native analysis core](prototype/README.md),
[the independent public study](extended-public/README.md), and
[the mixed-language audit](diagnostics/README-audit.md). The body below retains
the initial smaller-corpus study; its measurements and implementation limits
belong to that earlier experiment, not the expanded prototype.

This research compares language analysis and full-text retrieval while retaining
SQLite FTS5 as Omnesis's index. It does not change production search behavior.
All gateway stores used by the probes are isolated and synthetic.

[findings.json](findings.json) retains aggregate measurements, per-language
results, versions, hashes and the native feasibility checks without redistributing
the benchmark corpus or queries.

## Recommendation

Build one versioned lexical-analysis package with a shared indexing/query API:

- **ICU4X word segmentation** for a portable Unicode baseline, including Chinese
  and Japanese dictionary segmentation.
- **Lean Charabia/Lindera** for Korean morphology and Charabia's other useful
  normalizers/segmenters. Its Korean dictionary resolves the attached-ending
  reproduction in public issue 902.
- **Snowball** for language-specific word-ending matching.
- **Document/span language metadata**, with confidence-aware detection and
  script routing. Short queries should try the applicable enabled analyzers;
  their language cannot reliably be inferred in isolation.
- **An analysis-aware query compiler.** Unquoted natural-language queries search
  analyzed terms; explicit quotes retain phrase semantics. Exact spellings and
  compound/phrase evidence should remain available for ranking.

This is one application integration surface containing established algorithms,
not a claim that a single library automatically handles every language. The
recommended combination is a research direction; the combined production
package, query compiler and index migration are not implemented here.

## Evidence

### Public retrieval benchmark

The pinned NanoMIRACL subset contains **29,897 passages and 3,403 queries across
18 languages**. Query/relevance provenance comes from MIRACL; the subset retains
one positive per query. Scores are macro-averaged across languages. Higher is
better; these scores are not percentages of search queries answered correctly.

| Configuration                            | nDCG@10 | Recall@100 |
| ---------------------------------------- | ------: | ---------: |
| Current Porter/unicode61 query behavior  |  0.5220 |     0.8433 |
| ICU4X + Snowball, analyzed terms         |  0.6182 |     0.9656 |
| Full Charabia + Snowball, analyzed terms |  0.6322 |     0.9826 |
| Lean Charabia + ICU4X, rank fusion       |  0.6251 |     0.9820 |
| Exploratory capability-based route       |  0.6324 |     0.9814 |

The capability route selects ICU4X for Chinese/Japanese, whose dictionaries the
lean build omits, and lean Charabia elsewhere. It essentially retains the full
build's measured quality. This policy was introduced after inspecting results:
it requires held-out confirmation and uses configured monolingual split
languages, not automatic mixed-language routing.

The fundamental query-compiler result is reproducible: preserving every original
space-delimited group as a phrase turns many unspaced Chinese/Japanese/Thai
questions into whole-question exact-phrase queries. Searching analyzed terms
removes that failure. Quoted phrase controls remain strict. Naively OR-ing the
parts of a compound can retrieve partial matches, so candidate recall and final
ranking must be assessed separately.

Full Charabia improves nDCG on 16 of the 18 language splits against the current
baseline. Spanish and Yoruba regress slightly. Generic fusion also weakens
Korean compared with its dedicated analyzer. These observations argue for
capability-aware routing and per-language regression gates, rather than adding
all available scores together.

### Synthetic diagnostics and actual gateway proof

[cases.json](cases.json) contains **114 contrastive cases in 30 languages**,
including attached endings, compounds, irregular inflections, Unicode forms,
short queries, mixed scripts and hard prefix/substring negatives. They were
written independently of analyzer results and have not had native-speaker
review. This deliberately difficult set is diagnostic, not a population sample.

The unchanged gateway BM25 functions retrieve the positive in 27 cases. A native
Charabia-only FTS5 bridge retrieves it in 40, with identical candidate order via
SQLite and the existing memory-ranker path on every case. Document-ID
restrictions remain effective. The issue 902 query retrieves its suffixed
document and excludes the shared-component negative in the grouped-query arm.

The broader pipeline experiments separately evaluate language detection,
query fanout, Snowball, ICU4X, and optional Simplemma dictionary lemmatization.
Candidate unions report recall/negative retrieval only; they do not invent a
combined ranking score. Oracle language-hinted arms are explicitly identified.

Dictionary lemmatization is a useful follow-up candidate for irregular forms,
Hebrew and Ukrainian. Simplemma 2.0.0 is Python-only in this experiment; no
portable runtime integration or public-corpus ranking benefit is claimed.

### Footprint and performance

Prototype compressed artifacts at gzip level 6:

| Component                    | Compressed size |
| ---------------------------- | --------------: |
| Full Charabia native library |         70.3 MB |
| Lean Charabia native library |         21.5 MB |
| ICU4X probe executable       |          2.8 MB |

The lean library plus ICU4X is approximately 24.3 MB before final combined
packaging and stemmer/detector additions. These are separate prototype artifacts;
a final shared library could have different size and memory behavior. The
fastText probe plus its compressed language model totals under 1.7 MB before
compression. Dictionary/model notices must be inventoried separately from the
wrapper libraries' licenses.

The actual native bridge passes insertion, update, deletion, phrase, original
byte-offset highlighting, encrypted storage, and keyed read-only reopening
checks. A repeated 10,000-document synthetic benchmark records index, query,
posting and memory-array costs. Its warmed, repetitive workload does not
establish production-scale throughput or a latency advantage.

The existing memory ranker declines queries that tokenize one original word into
several terms, because it lacks positions. The prototype falls back on 4 of 20
language-stratified benchmark queries. A production query representation must
address that cost; simply replacing the tokenizer is insufficient.

## Reproduction

Keep compiled artifacts, downloaded models, benchmark corpora and output reports
outside the repository. Use the environment's normal admission mechanism for
heavy builds and benchmarks.

```sh
eval_scratch=$(mktemp -d)
python3 -m pip install --target "$eval_scratch/python" \
  snowballstemmer==3.1.1 simplemma==2.0.0 pyarrow==23.0.1
export PYTHONPATH="$eval_scratch/python${PYTHONPATH:+:$PYTHONPATH}"

export CARGO_TARGET_DIR="$eval_scratch/charabia-full"
sh evals/multilingual-search/charabia-probe/build-native.sh \
  node_modules/better-sqlite3/deps/sqlite3 --locked

export CARGO_TARGET_DIR="$eval_scratch/charabia-lean"
sh evals/multilingual-search/charabia-probe/build-native.sh \
  node_modules/better-sqlite3/deps/sqlite3 \
  --no-default-features --features lean --locked

CARGO_TARGET_DIR="$eval_scratch/icu4x" cargo build --release --locked \
  --manifest-path evals/multilingual-search/icu4x-probe/Cargo.toml

python3 evals/multilingual-search/run.py --snowball python --simplemma \
  --query-mode analyzed-or \
  --charabia "$eval_scratch/charabia-lean/release/omnesis-charabia-probe" \
  --icu4x "$eval_scratch/icu4x/release/omnesis-icu4x-probe" \
  --output "$eval_scratch/synthetic.json"
```

`--query-mode grouped` reproduces the original-word grouping arm. `--lucene
evals/multilingual-search/lucene-probe/run.sh` adds the actual Lucene retrieval
reference. See [the public benchmark instructions](README-public.md),
[the Lucene helper](lucene-probe/README.md), and
[the detector helper](fasttext-probe/README.md) for their pinned dependencies.
`--detector-cache` accepts the detector comparison report and prefers its
independently checked official implementation outputs when available.

The FTS5 bridge is a Charabia-only feasibility prototype. Linux native loading
has been exercised; macOS relocation, Windows distribution, all token graphs,
and the combined analysis pipeline have not. The current index's startup
tokenizer migration would also need an explicit change: production must store an
analysis fingerprint, rebuild affected indexes and preserve raw documents.

## Sources and frozen inputs

- Base source revision: `bbe207a37bfd733ee4516edc0605fbecba88c15f`.
- Synthetic fixture canonical JSON SHA-256 (UTF-8, two-space indentation and a
  terminal newline; the driver also records the exact source-file hash):
  `fb4752f2a1e361071fc49efe0809d6f3b63d347da6e1c936a11678ffccbec315`.
- [NanoMIRACL](https://huggingface.co/datasets/hotchpotch/NanoMIRACL), pinned
  revision `6e98c995a5be54ef41d3a016a2f30314dd625619`; downloaded files are verified
  against their upstream LFS hashes. This is a curated subset of the source
  relevance pools, retaining one positive per query; unjudged passages are not
  confirmed negatives. The separately supplied BM25 candidate lists were not
  used by this evaluation.
- [Original MIRACL](https://huggingface.co/datasets/miracl/miracl).
- [Charabia](https://github.com/meilisearch/charabia), 0.10.0. The default build
  forces UniDic for Japanese; the lean build omits Japanese/Chinese dictionaries.
- [ICU4X WordSegmenter](https://docs.rs/icu_segmenter/2.4.0/icu_segmenter/struct.WordSegmenter.html),
  2.4.0, dictionary mode for the portable comparison.
- [Snowball](https://snowballstem.org/algorithms/), evaluated through the 3.1.1
  Python implementation; system libstemmer is a separately labeled older arm.
- [Simplemma](https://github.com/adbar/simplemma), 2.0.0, optional challenger.
- [Lucene](https://lucene.apache.org/core/9_12_3/), 9.12.3, actual in-memory
  retrieval with analyzer graph/phrase support.
- [fastText language model](https://fasttext.cc/docs/en/language-identification.html),
  `lid.176.ftz`; the Rust probe's top-one labels were independently checked
  against official fastText 0.9.2. Lower-ranked predictions differ on some inputs.

New dictionaries are research dependencies, not vendored or redistributed assets.
Library licenses do not replace dictionary/model licenses. All production
packaging decisions and language-specific relevance policies remain reviewable
implementation work.

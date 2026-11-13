# Public multilingual retrieval challenger

This complements the synthetic contrastive fixtures with native-speaker-labeled
queries from MIRACL. It evaluates lexical ranking on a frozen **NanoMIRACL**
subset, not the full MIRACL collections and not the production gateway pipeline.
No passage text, query text, names, or corpus excerpts belong in this repository.

## Dataset and provenance

- Dataset: [hotchpotch/NanoMIRACL](https://huggingface.co/datasets/hotchpotch/NanoMIRACL)
- Frozen commit: `6e98c995a5be54ef41d3a016a2f30314dd625619`
- Exact paths: `corpus/<language>-00000-of-00001.parquet`,
  `queries/<language>-00000-of-00001.parquet`, and
  `qrels/<language>-00000-of-00001.parquet` for all 18 published language splits.
- The similarly named `NanoMIRACL-<language>` files are a different set and are
  deliberately not mixed into this benchmark.
- Each file is verified against its SHA-256 LFS object ID in the pinned Hugging
  Face tree. The scratch manifest records all hashes and byte sizes.

MIRACL queries and relevance judgments were created by native speakers, and its
passages come from Wikipedia. NanoMIRACL derives its data through
`hotchpotch/miracl-hf-unified`, retains one positive per selected query, and samples
source negatives into a smaller corpus. This inherits sampling and retrieval-pool
bias; it is not a random sample of personal documents. The retained qrels contain
**positives only**: an unjudged passage is not a confirmed negative, and another
genuinely relevant passage may receive no credit.

NanoMIRACL's card declares `license: other` and delegates compliance to upstream
terms. The upstream MIRACL topics/qrels card declares Apache-2.0; Wikipedia
passages retain their applicable upstream rights and attribution requirements.
This experiment downloads data locally without redistributing passages. Dataset
cards and upstream licenses should be reviewed before any redistribution.

Sources: [NanoMIRACL pinned card](https://huggingface.co/datasets/hotchpotch/NanoMIRACL/blob/6e98c995a5be54ef41d3a016a2f30314dd625619/README.md),
[MIRACL topics/qrels](https://huggingface.co/datasets/miracl/miracl),
[MIRACL corpus](https://huggingface.co/datasets/miracl/miracl-corpus).

## Reproduction

Install `pyarrow==23.0.1` and `snowballstemmer==3.1.1` in a disposable Python
environment. Build both the full and lean Charabia helpers as documented in the
main experiment. Download the public data into an external scratch directory:

```sh
python3 evals/multilingual-search/download-public.py --data-dir /tmp/multilingual-public-data
```

Run the benchmark through the host's installed heavy-work admission queue when
one is configured. The underlying command is:

```sh
python3 evals/multilingual-search/public-benchmark.py \
  --data-dir /tmp/multilingual-public-data \
  --charabia-full /path/to/full/omnesis-charabia-probe \
  --charabia-lean /path/to/lean/omnesis-charabia-probe \
  --output /tmp/multilingual-public-results.json
```

`--languages` narrows the run, and `--max-queries` is an explicitly reported
diagnostic cap. Every method still searches the complete downloaded language
corpus. The benchmark **does not use** the supplied BM25 top-100 candidate files,
whose generation forces missing positives into the candidate list.

`--query-mode phrase-groups` is the initial compatibility arm described below.
`--query-mode analyzed-or` is a separate query-compiler arm: unquoted analyzed
tokens become individual OR clauses, while an explicitly quoted input remains
one phrase. The current-Porter baseline is unchanged in either arm. Record each
arm to a separate output file; every method reports its query mode and candidate
methods count original groups, analyzed tokens, and compiled clauses.

This distinction matters for languages without spaces: preserving every
whitespace-delimited group as a phrase can accidentally require an entire
Chinese question to appear verbatim in a passage. Poor compatibility-arm results
therefore test the whole query compiler, not segmentation quality in isolation.

`--icu4x /path/to/omnesis-icu4x-probe` substitutes a portable ICU4X probe in
dictionary mode for Node's `Intl.Segmenter`. Language hints and the rest of the
retrieval protocol remain unchanged. Engine/version and the binary checksum are
recorded in the result. Use a separate output file when comparing ICU runtimes;
their dictionary versions and segmentation can differ.

## Compared configurations

1. **Current Porter:** raw corpus text with SQLite's
   `porter unicode61 remove_diacritics 2` and the existing query sanitizer.
2. **ICU + Snowball:** Node's `Intl.Segmenter` with the known corpus language,
   NFKC normalization, language-aware lowercase, Latin accent folding, and
   Snowball where that language has an available algorithm. With `--icu4x`, the
   explicitly reported portable dictionary-mode segmenter replaces Node Intl.
3. **Full Charabia + Snowball:** all-feature Charabia with the known corpus
   language and NFKC normalization, followed by available Snowball stemming.
4. **Lean Charabia + Snowball:** the reduced-dictionary helper under the same
   configured-language protocol.
5. **Lean + ICU RRF:** reciprocal-rank fusion of the top 100 results from
   configurations 2 and 4, using equal weights and `k=60`.
6. **Current + lean + ICU RRF:** the same fusion including configuration 1.

Language labels are a **benchmark configuration**, not successful automatic
language detection. The dataset is divided into monolingual corpora; these
results cannot demonstrate routing quality on mixed-language personal data.

The report also derives an **exploratory capability route**: ICU + Snowball for
Chinese/Japanese because the lean build omits their dictionaries, and lean
Charabia + Snowball elsewhere. This policy was proposed after inspecting initial
results, uses the known language split rather than automatic detection, and
needs held-out confirmation. Its aggregate reuses existing per-language scores;
it is not an independently executed mixed-language routing experiment.

For candidates, both documents and original query words are analyzed consistently;
combining marks survive query sanitization. In the compatibility arm, multiple
pieces produced from one original query word are matched as an FTS5 phrase, and
original query words are ORed. In the analyzed-OR arm, each unquoted analyzed
token is an OR clause. Analyzed tokens are
UTF-8-hex encoded before indexing, so SQLite cannot silently reinterpret their
identity. This is an experimental representation, not a storage-size proposal.

## Report and limits

The report contains per-language and unweighted language-macro **nDCG@10**,
**Recall@100**, and **MRR@10**, plus per-query metric values for paired analysis.
With one retained positive per query, Recall@100 is simply whether that retained
positive appears in the top 100. Document insertion order is based on ID hashes,
independent of relevance labels, to avoid positive-first tie bias.

Timings separate document analysis, query-group analysis, SQLite indexing/token
transformation, query-expression transformation, and SQL queries. Analyzer timing
includes subprocess startup; Python stemming, process boundaries, hex encoding,
and the small corpora make these **diagnostics rather than production throughput
or latency estimates**. Fused methods additionally report fusion time and should
include both component costs when assessing deployment cost.

Treat these results alongside the synthetic boundary/short-query controls. A
higher score here alone does not establish that broader normalization is safe,
that all languages are supported, or that original stored text may be discarded.

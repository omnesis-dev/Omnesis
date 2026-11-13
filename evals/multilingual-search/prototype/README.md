# Native multilingual lexical-analysis prototype

This research prototype joins one portable Rust analysis core to a JSON-lines
CLI and a SQLite FTS5 extension. It does not change production search defaults.
No language detector, corpus, model download, or external service runs inside
the tokenizer.

The core uses ICU4X 2.4.0 word boundaries and locale-aware casing, Charabia
0.10.0 with Lindera 5.3.0 for Korean morphology and configured German compound
splitting, and Frostem 2.20261016.3 for Snowball stemming. Extra lossy folding is
disabled by default. Chinese and Japanese
use ICU4X dictionaries, avoiding Charabia's large Japanese dictionary. Thai and
Khmer also use ICU4X rather than Charabia's separate segmentation dictionaries.
Thai retains its discriminative marks; Charabia's lossy Thai mark-removal
normalizer is bypassed even when optional broad folding is selected.
Charabia's `thai` feature is nevertheless enabled because version 0.10.0 gates
shared utilities needed by its German segmenter behind `thai` or `khmer`.
This upstream feature coupling adds data even though the prototype routes Thai
through ICU4X; the dependency registry is not patched.

Frostem's `upstream-pin.toml` records Snowball commit
`06e1f74f7cf61ea8913c6269480b8d392c33dbae`, dated November 11, 2026. Its date-based
crate version is not a claim of identity with a released Python Snowball
version; the separate stem probe supports explicit parity comparisons.

## Build and test

Rust 1.100.0 is the evaluated toolchain. ICU4X declares Rust 1.88 as its minimum;
this prototype does not claim its complete dependency graph was tested on that
minimum. Set `CARGO_TARGET_DIR` outside the repository. Generate no model or
dictionary artifacts in Git.

```sh
rustup toolchain install 1.100.0 --profile minimal
cargo +1.100.0 test --locked --manifest-path evals/multilingual-search/prototype/Cargo.toml
sh evals/multilingual-search/prototype/build-native.sh node_modules/better-sqlite3/deps/sqlite3
```

Use the repository/host admission mechanism when running heavy builds or tests.
The build script enforces the lockfile and defaults `CARGO_BUILD_JOBS` to two.
It contains Linux and macOS build recipes; each platform's runtime compatibility
must be established by its own tests. No Windows build recipe is provided.

Outputs under the external target's `release/` directory:

- `omnesis-multilingual-prototype`: JSON-lines analyzer.
- `omnesis-snowball-probe`: raw token-stemming diagnostic, without normalization.
- `libomnesis_multilingual_core.so` / `.dylib`: Rust analysis library.
- `libomnesis_multilingual.so` / `.dylib`: SQLite extension; keep its core library
  next to it so the relative loader path resolves.

## JSON-lines API

Each input line is independent and produces one flushed output line:

```json
{ "text": "파란고래우체통입니다", "language": "ko", "mode": "stem" }
```

`language` is an optional ISO-2, common ISO-3, or language identifier with region
and script subtags; it defaults to `und`. `mode` is `exact` or `stem` and defaults
to `stem`. Optional `segmenter` selects `dictionary` (default) or `auto` ICU4X
segmentation. Optional `prefix:true` skips stemming the final query token.
Optional `folding` is `none` (default) or the explicitly lossy `broad` policy.

Responses contain `tokens`, the canonical `language`, `fingerprint`, pinned
dependency versions, and Snowball provenance. Each token has searchable `text`,
normalized `surface`, original UTF-8 byte `start`/`end`, a consecutive `position`,
`colocated:false`, effective `language`, `script`, and optional stemmer
`algorithm`. A normalization expansion can produce several consecutive tokens
with the same original byte range. No synonym token graph is emitted.

`exact` preserves normalized surfaces after linguistic segmentation; it does
not mean byte-exact matching or preservation of unsplit compound words. `stem`
adds applicable Snowball stemming. Keep these lanes separate
when exact matches should rank above broader matches. Original document text
remains authoritative and is never rewritten.

With `folding:none`, marks are preserved outside transformations explicitly
performed by the selected Snowball algorithm. `folding:broad` additionally runs
Charabia's applicable Latin, Greek, Arabic, Hebrew, and CJK normalizers after
stemming, including accent/optional-vowel removal and Chinese variant folding.
It can collapse distinct Vietnamese, Yoruba, Turkish, or other words and is an
experimental alternative, not a universally safe default. It does not apply to
Thai, Indic, Khmer, or Myanmar scripts. The exact lane ignores lossy folding.

ICU word spans whose detected dominant script is Hangul select Korean
segmentation even inside a differently labeled document. Unspaced mixed-script
identifiers can remain one ICU word, so a long Latin prefix can influence that
dominant-script choice; routing is not an exhaustive per-codepoint script split.
Stemming other scripts requires a compatible language hint. A single
document-level hint cannot identify multiple languages sharing the Latin or
Cyrillic script; callers must evaluate span hints, parallel lanes, and query
fanout. Unsupported stemming languages retain normalized tokens.

## SQLite API and language metadata

Load the SQLite extension before creating or reading its FTS5 tables:

```sql
SELECT omnesis_multilingual_capabilities();
SELECT omnesis_multilingual_analyze('recipes', 'en', 'stem');
SELECT omnesis_multilingual_fingerprint('en', 'stem');

CREATE VIRTUAL TABLE documents USING fts5(
  content, locale=1,
  tokenize='omnesis_multilingual_v1 language und mode stem'
);
INSERT INTO documents(content) VALUES(fts5_locale('fr', 'des recettes'));
SELECT rowid FROM documents WHERE documents MATCH fts5_locale('fr', 'recette');
```

SQLite 3.47.0 introduced FTS5's tokenizer-v2 and locale APIs. The extension
registers v2 when `fts5_api.iVersion >= 3`. Per-value locale metadata overrides
the tokenizer's fallback `language` argument during indexing, querying, and
auxiliary tokenization. An external-content view can expose
`fts5_locale(language, content)` while retaining unchanged original text in the
base table. Insert/update/delete trigger values must carry the corresponding
old or new locale too. Locale argument order is **language, text**.

On older FTS5 APIs the extension registers a legacy tokenizer. Use explicit
per-table `language` arguments there; dynamic locales and the compiled-term
locale are unavailable. The capabilities function reports which API is active.
No invisible global language state is used by either implementation.

Tokenizer arguments are key/value pairs: `language`, `mode`, and optional
`segmenter` and `folding`. The SQL analyzer accepts an optional fourth segmenter
and fifth folding argument; the fingerprint function accepts them as its
optional third and fourth arguments. Their shorter forms use `dictionary` and
`none`.

### Already-analyzed queries

Stemming can be non-idempotent. Do not compile stem strings into ordinary MATCH
syntax and run the analyzer over them again. On the v2 API the reserved locale
`und-x-omnesis-terms-v1` accepts already-analyzed terms only for query callbacks:

```sql
SELECT rowid FROM documents
WHERE documents MATCH fts5_locale('und-x-omnesis-terms-v1', '"recet"');
```

The compiler must quote each term, doubling embedded quote characters. Join
separate quoted terms with compiler-owned `OR`, or join an explicit phrase's
terms with ASCII spaces inside a single quoted phrase. The reserved callback
splits only on ASCII whitespace and performs no normalization or stemming.
Document/auxiliary callbacks and the ordinary language configuration reject
this reserved locale. Analyzed terms cannot contain ASCII whitespace or NUL.

## Generation identity and limitations

Fingerprints hash the core Rust/C sources, dependency lockfile, and canonical
language/mode/segmenter/folding configuration. Persist and validate them with index and
memory-cache generations. A fingerprint does not implement a migration or
detect changes to an external language detector; the integration harness owns
those separate responsibilities.

The pinned Korean source archive is
`mecab-ko-dic-2.1.1-20180720.tar.gz` (49,767,335 bytes), with SHA-256
`702ced21c6167e9d9aebc674ab5ee54af58d4443975f2940d37d0567c020591a`.
Lindera's pinned build script checks its MD5
`b996764e91c96bc89dc32ea208514a96` before unpacking downloads or cached archives.
This prototype rejects `DOCS_RS`, custom context-frequency input, and external
Lindera dictionary-cache overrides, since those can replace the declared
dictionary semantics. The declared archive SHA is returned in analysis
metadata; the prototype does not claim to hash every embedded dictionary byte
at runtime. A distribution pipeline should verify its archived build inputs
and retain the dictionary notices.

ICU4X word-status filtering has a measured combining-mark edge case. The
prototype retains segmented spans containing Unicode letters or digits even
when the reported status is nonword. NFKC runs before segmentation so composed
and decomposed Hangul receive the same morphological analysis. Original-byte
ranges are mapped through normalized grapheme clusters; adjacent source ranges
are merged when compatibility characters compose across an original boundary.
The concatenated result is checked against whole-text NFKC. Ligature expansion
can create multiple words with consecutive positions sharing an original
range. Empty stemming results retain their surface so positions are not erased.

The prototype deliberately leaves relevance weighting, global versus language
statistics, document-language selection, alternative query analyzers, prefix
precision policy, migration scheduling, and production packaging to explicit
integration experiments. Dictionary-based analysis also does not guarantee
correct segmentation of every unfamiliar name or compound.

## Dependency provenance

All source files in this directory are project-owned. Dependencies are fetched
through the checked-in Cargo lockfile rather than vendored here. Charabia and
Lindera are MIT-licensed; ICU4X is Unicode-3.0; Frostem and its Snowball-generated
code are BSD-3-Clause. The Korean dictionary is separately licensed under
Apache-2.0. Distribution of a built artifact must retain the dependencies' and
dictionary's notices. Cargo metadata alone is not a complete binary notice
bundle.

`snowball-parity.py` compares the raw Rust stem probe with exactly Python
`snowballstemmer` 3.1.1. It samples official Snowball vocabularies at stable
intervals, pins their Git commit in its report, and records each downloaded
file's hash and every observed mismatch. Pass `--data-commit` to replay that
same snapshot. Vocabulary caches and reports must stay outside the repository;
their upstream licenses are separate from the Rust inference code, and some
language directories have their own `COPYING` files. This is a sampled snapshot
comparison, not a proof of algorithm equivalence.

```sh
python3 evals/multilingual-search/prototype/snowball-parity.py \
  --probe "$CARGO_TARGET_DIR/release/omnesis-snowball-probe" \
  --cache /path/outside-checkout/vocabularies \
  --output /path/outside-checkout/snowball-parity.json
```

Primary references:

- <https://www.sqlite.org/releaselog/3_47_0.html>
- <https://www.sqlite.org/fts5.html#the_locale_option>
- <https://github.com/meilisearch/charabia>
- <https://github.com/lindera/lindera>
- <https://docs.rs/icu_segmenter/2.4.0/icu_segmenter/struct.WordSegmenter.html>
- <https://github.com/Xuanwo/frostem>

## Separate exploratory diagnostics

These helpers do not modify the frozen analyzer or relevance fixtures:

```sh
python3 evals/multilingual-search/prototype/lexical-trace.py \
  --analyzer "$CARGO_TARGET_DIR/release/omnesis-multilingual-prototype" \
  --korean-probe "$CARGO_TARGET_DIR/release/omnesis-korean-mode-probe" \
  --output /path/outside-checkout/lexical-trace.json
python3 evals/multilingual-search/prototype/robust-input.py \
  --analyzer "$CARGO_TARGET_DIR/release/omnesis-multilingual-prototype" \
  --output /path/outside-checkout/robust-input.json
python3 evals/multilingual-search/prototype/footprint.py \
  --cli "$CARGO_TARGET_DIR/release/omnesis-multilingual-prototype" \
  --core "$CARGO_TARGET_DIR/release/libomnesis_multilingual_core.so" \
  --adapter "$CARGO_TARGET_DIR/release/libomnesis_multilingual.so" \
  --model /path/outside-checkout/optional-detector-model.bin \
  --output /path/outside-checkout/footprint.json
```

Use `.dylib` for macOS libraries. Omit `--model` when no external detector model
is deployed. Pass `--detector` to include its executable as well. Footprint totals count the provided CLI, core and adapter together,
including duplicated embedded data, plus a separately reported optional model.
A separate FTS-extension total excludes the diagnostic CLI.
They measure disk bytes and deterministic per-file gzip level-6 bytes, exclude
RAM and index storage, and do not strip or rewrite the provided artifacts.

The robust-input diagnostic submits 140 synthetic cases twice in one process,
with a bounded subprocess timeout. It checks valid original UTF-8 byte offsets,
consecutive positions, deterministic responses, selected canonical Unicode
equivalence, and long-word/combining-mark inputs. It is not an exhaustive fuzzer
or a resident-memory measurement.

The lexical trace explicitly labels two previously observed Korean/Greek misses
and separate fresh word-pair controls. Its optional standalone Korean probe
compares raw Lindera Normal/Decompose modes, including original positions,
position lengths, and dictionary details. These traces do not claim a flattened
multi-token alternative is a valid phrase graph. It reports both analysis lanes with their
actual algorithm choices; shared-term checks are not retrieval-quality scores.
A dictionary morphological analyzer can select different segmentation for a
bare compound and its inflected form. A Snowball stemmer is a heuristic suffix
algorithm, and related Greek singular/plural forms need not produce identical
stems. Neither result can be fixed merely by supplying an already-correct
language hint. See the [Greek Snowball algorithm](https://snowballstem.org/algorithms/greek/stemmer.html)
and [Charabia's pinned Korean segmenter](https://github.com/meilisearch/charabia/blob/v0.10.0/charabia/src/segmenter/korean.rs).

## Korean compound-metadata challenger

`omnesis-korean-compound-probe` is a separate experimental JSON-lines executable.
Its [protocol](compound-policy.json) is declared independently of the frozen
primary analyzer. It accepts the same requests with `folding:none`, retains
precise exact-lane tokens, and expands proven Korean `Compound` dictionary
metadata only in the stem lane. Its fingerprint includes its own source and
protocol plus the frozen core fingerprint.

The constituent surfaces must concatenate exactly to the normalized token, and
every component boundary must map safely to original grapheme boundaries.
Malformed, inflectional, non-concatenative, and unsupported normalization cases
retain their original token. This is one flat constituent path with consecutive
positions, not an original-plus-parts graph. The separate exact lane retains the
precise stream. Decomposition is one level and does not guarantee that every
related Korean form will converge.

```sh
cargo test --release --locked \
  --manifest-path evals/multilingual-search/prototype/Cargo.toml \
  --bin omnesis-korean-compound-probe
```

Use the applicable host admission mechanism for this build/test command. The
standalone wrapper loads its own dictionary in addition to the frozen core's
private dictionary instance. Its process memory is not a measurement of a final
shared-dictionary integration.

## French/Persian preprocessing ablations

Two separate JSON-lines executables implement the independently declared
[normalization protocol](normalization-policy.json):
`omnesis-boundary-profile-probe` and `omnesis-language-norm-probe`. Both retain
frozen exact-lane tokens. Only stem-lane French Latin and Persian Arabic spans
receive the selected preprocessing; other languages/scripts remain unchanged.

Both start from the frozen normalized `surface`, split it with Charabia, and
stem the resulting words once. Boundary-only retains NFKC/locale casing without
Charabia normalizers. Language-norm explicitly applies compatible Charabia
normalization before Frostem, including selected accent/ligature/optional-mark
and numeral folding. Neither enables global broad folding. Each response
includes a distinct profile fingerprint and normalization metadata.

French accent folding can merge different words, and splitting Persian
halfspaces can expose a shared verb term in positive and negated expressions.
These are explicit broad-lane precision risks; normalization is not universally
safe. Common Arabic/Persian kaf and yeh variants are already normalized by the
Persian Snowball algorithm, so those variants alone do not explain the observed
aggregate regression. Sources: [French Snowball](https://snowballstem.org/algorithms/french/stemmer.html),
[Persian Snowball](https://snowballstem.org/algorithms/persian/stemmer.html), and
[Charabia's Persian normalizer](https://github.com/meilisearch/charabia/blob/v0.10.0/charabia/src/normalizer/persian.rs).

Offsets map directly for identity spans, including halfspaces, or through
checked original grapheme normalization/casing boundaries. Unsafe mappings
retain the entire frozen token. Positions remain consecutive, no stopwords are
removed, and prefix queries leave the final resulting token unstemmed while
still applying the selected profile's normalization.

```sh
cargo test --release --locked \
  --manifest-path evals/multilingual-search/prototype/Cargo.toml \
  --bin omnesis-boundary-profile-probe --bin omnesis-language-norm-probe
```

Use host admission for heavy commands. These are exploratory follow-ups to
inspected aggregate regressions, not untouched prospective primary methods;
separate retrieval reports must retain that qualification.

The bounded control helper records original/profile exact and stem streams,
original UTF-8 offsets, stable configuration fingerprints, and actual encoded
FTS OR/AND/phrase results for invented positive/negative cases:

```sh
python3 evals/multilingual-search/prototype/normalization-controls.py \
  --baseline "$CARGO_TARGET_DIR/release/omnesis-multilingual-prototype" \
  --boundary "$CARGO_TARGET_DIR/release/omnesis-boundary-profile-probe" \
  --language-norm "$CARGO_TARGET_DIR/release/omnesis-language-norm-probe" \
  --output /path/outside-checkout/normalization-controls.json
```

It explicitly checks and records the accent/negation precision risks. This
encoded-FTS control does not claim to exercise a native profile tokenizer
callback or measure public retrieval quality.

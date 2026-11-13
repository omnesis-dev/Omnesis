# Shared personal-knowledge lexical diagnostics

This collection complements the small contrastive fixtures and the public
Wikipedia benchmark. It asks how lexical retrieval behaves when unrelated
languages, document kinds, identifiers, and mixed-language passages share one
index. It does not change production search, run a language model service, create
embeddings, access a live gateway, or read private indexed data. Local fastText
language identification is an explicitly recorded optional research dependency.

## Frozen collection and relevance contract

`fixtures.json` contains independent development and heldout collections. Each
has 143 invented documents, 140 queries, and coverage of 30 languages. Development
uses workshop paperwork; heldout uses evening transport. The required topic
lexemes, reference codes, URLs, and fictional identities differ across splits.
There are nine mixed-language documents and three no-relevant queries per split.

Document kinds include receipt/calendar records, email/web reminders, short note
fragments, contact collisions, and paragraph handovers. Most topic paragraphs
have several sentences. Mean body length is approximately 189–194 Unicode
characters; the collections do **not** establish long-document or production
corpus behavior. The runtime scale/lifecycle study is separate.

The prose and labels were authored without inspecting the new analyzers'
outputs. They have **not received native-speaker review**. Templates are parallel
across languages, fragments repeat part of their parent record, and some
grammatical families recur. This is a diagnostic holdout, not an independent
sample of natural personal documents or proof of language-wide quality.

Every query has a written relevance rationale:

- `relevance` maps required lexical targets to grades 1–3.
- `compatible` lists same-topic alternatives that are not required to be
  translated/retrieved and are not confirmed negatives. This prevents identical
  or related words across languages from being mislabeled as irrelevant merely
  because they occur outside one language's target records.
- The remaining finite-collection records are contrastive negatives under the
  authored intent. Exact identifier, quote, and distinctive-mark controls have
  complete labels; natural-language relevance remains an authored judgment.
- Empty `relevance` is valid and means that this collection contains no relevant
  result for the query. It is evaluated separately from recall.

The fictional names and reserved `example.org` URLs are invented fixture data.
No personal names, stories, vendors, addresses, documents, or text from an
operator's corpus were used.

## CLI and dependencies

The driver uses Python 3's standard library and SQLite FTS5. Fixture validation
does not need a compiled analyzer or detector:

```sh
python3 evals/multilingual-search/diagnostics/run.py --validate-only
python3 -m unittest discover -s evals/multilingual-search/diagnostics -p 'test_*.py'
```

The underlying benchmark command is:

```sh
python3 evals/multilingual-search/diagnostics/run.py \
  --analyzer /path/to/omnesis-multilingual-prototype \
  --detector /path/to/omnesis-fasttext-probe \
  --detector-model /path/to/lid.176.ftz \
  --cache-dir /tmp/multilingual-diagnostics-cache \
  --split development \
  --output /tmp/multilingual-development.json
```

Use the host's installed admission wrapper for heavy local checks and benchmark
runs. Keep caches, binaries, language models, and generated reports outside Git.
`--split heldout` evaluates the untouched topic split with the same policy;
`--split all` produces both reports. All compared policies are declared in the
driver before results; the driver does not select a winner or tune thresholds.
`freeze.json` fixes fixture content and heldout policy parameters before the first
development run. Alternate development parameters are labeled as nonfrozen;
heldout/all runs reject a mismatch rather than silently changing the protocol.

`--official-detector /path/to/fasttext` optionally compares top-one labels with
the official fastText CLI and uses that reference's outputs. Without it, results
are labeled as the JSONL detector implementation rather than an independently
verified reference. Confidence thresholds are research parameters, not claims
that detector probabilities are calibrated.

The analyzer contract is JSONL `{text,language,mode}` with `mode` equal to `exact`
or `stem`; responses contain `tokens:[{text,start,end,...}]`, UTF-8 source offsets,
`fingerprint`, and `version`. Analyzer `exact` means linguistically segmented and
normalized surfaces. It does **not** replace the separate mark-preserving
surface representation. UTF-8 boundaries and flat increasing positions are
validated; positions must be consecutive from zero, so encoding cannot erase
stopword gaps. Colocated token graphs are outside the supported API.
The detector contract is JSONL `{text}` with
`{detection:{language,confidence},predictions:[...]}`; its model is a CLI argument.

## Fixed comparison matrix

The driver compares current raw Porter/unicode61 behavior with three research
representations:

1. **Surface:** NFC plus Unicode case folding for ordinary words, without accent
   stripping. Reference-code atoms remain case-sensitive. URL scheme/host case
   normalizes while path/query/fragment case is preserved. Column boundaries
   prevent phrases from crossing title, body, author, URL, or code fields.
   Ordinary-word Unicode case folding can merge spellings such as `ß` and `ss`;
   this lane is not a byte-exact document lookup.
2. **Normalized:** unified analyzer `exact` and `stem` modes. Unquoted analyzed
   terms are ORed; explicitly quoted text remains a phrase. This arm deliberately
   exposes collisions if language normalization changes distinctive spellings or
   breaks an identifier into common terms.
3. **Surface priority:** explicit quotes and whole code/URL queries use only the
   surface representation. For natural queries, complete adjacent surface
   evidence precedes complete unordered surface evidence, followed by equal
   reciprocal-rank fusion of surface and normalized candidates. This is a fixed
   prototype ranking rule, not a validated production policy or universal query
   intent classifier.

Each normalized representation is evaluated with:

- **Hard detection:** one top-one document language and one top-one query
  language, with no special treatment of short-query uncertainty.
- **Context/script:** script-separated paragraph spans, unique-script routing,
  confident sufficiently long-span detection, then an explicit compatible
  notebook/query context hint, otherwise `und`. Fixture truth labels never
  choose an analyzer. English notebook context on mixed handovers is deliberately
  insufficient to label their minority-language passages. Script runs cannot
  separate English and Spanish within one Latin-script paragraph; explicit
  same-script handovers expose this limit instead of assuming perfect spans.
- **Query fanout:** the same span-aware document indexing as context/script, but
  queries try the script-compatible enabled languages plus `und`. The number of
  query variants is reported instead of treating this work as free.

Default detector threshold is 0.6 with at least 20 letters; both are recorded
parameters. They were selected as conservative diagnostic controls, not fitted
or calibrated against heldout judgments. Rank-fusion constant is 60 and candidate
depth is at least 100. The policy fingerprint covers these parameters.

Two index layouts use exactly the selected per-document/span tokens:

- **Global:** a shared FTS5 corpus and shared BM25 term/document-length statistics.
- **Language lanes:** independent per-language FTS5 statistics, combined with
  reciprocal-rank fusion. Raw BM25 scores from incomparable lanes are never added.

Encoded analyzer tokens preserve their identity on the Python SQLite version
reported by the driver. This offline comparison does **not** exercise the newer
native per-value locale API. Title weight is 2; body/author/URL/code weights are 1.
Unqueryable sentinel tokens prevent phrases crossing independent normalized
spans. They also contribute to this offline index's document-length statistics;
the span-policy comparison is not a measurement of a native position-gap design.

## Metrics and interpretation

Reports keep ranking and candidate recall separate:

- Required-target Recall@10/@100, MRR@10, and top-one success use the original
  returned ranking.
- Precision@10 lower bounds count required targets only; upper bounds also count
  compatible alternatives. Missing result positions count as zero. Both bounds
  are reported only for queries with required targets.
- Confirmed-negative count/exposure and compatible-alternative count are
  separate. Returning an alternative is not called a false positive.
- Condensed required-target nDCG@10 removes compatible alternatives before
  scoring. Its name is deliberate: it is **not** ordinary exhaustive-judgment
  nDCG and must not be substituted for the public benchmark's metric.
- No-relevant queries report false-result rate instead of undefined recall.
- Mixed required-target recall measures whether minority-language target records
  are recovered, even when an easier monolingual relevant record ranks first.

Every aggregate states its query denominator. Per-category and per-language
breakouts are essential: the overall mean contains many structural identifier
controls and must not be presented as population accuracy. The report retains
document/query IDs and ranked IDs, not duplicated fixture prose.

Canonical fixture and exact file hashes, source hashes, policy fingerprints,
analyzer fingerprints, binary/model checksums, detector parity, SQLite version,
and cache usage are recorded. Token-cache runs do not measure live analysis
latency; query/index times exclude preprocessing and are diagnostic only.

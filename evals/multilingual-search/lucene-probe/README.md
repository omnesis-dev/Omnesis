# Lucene analyzer reference probe

This JSONL helper compares established language analyzers and supports an actual
in-memory Lucene retrieval reference without replacing Omnesis's SQLite engine.
It is a quality reference, not an Omnesis runtime integration. Requires
Java/Javac 17 and Python 3; Maven is unnecessary.

```sh
bash evals/multilingual-search/lucene-probe/run.sh <<'JSONL'
{"text":"파란고래우체통입니다","language":"ko"}
{"text":"книги","language":"uk"}
JSONL
```

`prepare.py` downloads checksum-pinned Maven Central artifacts into the system
temporary directory and compiles the helper there. Pass `--cache-dir PATH` to
choose another scratch directory. No dependency or compiled output belongs in
Git. The dependency set occupies approximately 28 MB before JVM memory overhead.

## Frozen dependencies

- Apache Lucene **9.12.3**, the latest 9.12 release listed in Maven Central metadata
  when preparing this probe. Lucene 10 requires a newer Java runtime.
- Gson **2.13.2**, a stable 2.13 release.
- Morfologik stemming/FSA/Polish dictionaries **2.1.9** and Ukrainian search
  dictionary **4.9.1**, the versions declared by Lucene's Morfologik module.

Lucene and Gson use Apache-2.0 licenses. Morfologik and the Ukrainian dictionary
have their own licenses/notices inside their downloaded artifacts; these are
research dependencies, not vendored or redistributed files. Shipping any of
these dependencies requires a separate license and packaging review.

## Contract and defaults

Input: `{"text":"...","language":"ISO-2"}`. Every nonblank line produces one
JSON result. Invalid input produces an `error` object. The helper keeps analyzers
warm until stdin closes.

`mode:"oracle"` (the default) uses `language`. `mode:"route"` uses
`routeLanguage` if supplied, otherwise `language`. These names describe externally
provided hints; the helper performs **no language detection**. Passing the true
fixture language measures an oracle, not automatic routing quality.

Output contains `tokens:[{text,start,end,position,positionIncrement,positionLength}]`,
the selected `analyzer`, `version`, `languageUsed`, `mode`, `fallback`, and
`offsetUnit:"utf16"`. Offsets count Java UTF-16 code units, not UTF-8 bytes.
Position increments preserve stopword gaps and synonym alternatives. Consumers
that flatten tokens lose token-graph/phrase semantics and must label that limit.

All analyzers use their **unmodified default constructors**: default stopwords,
stemmer strength, dictionaries, normalization, and compound handling. There is no
extra NFC conversion, accent folding, stemming, custom dictionary, or
language-dependent repair outside what the selected Lucene analyzer supplies.
Korean uses Nori, Japanese uses Kuromoji, Chinese uses SmartChinese, Thai uses
ThaiAnalyzer, Polish uses Stempel, and Ukrainian uses Morfologik.

Other specialized mappings cover Arabic, Bengali, Czech, Danish, German, Greek,
English, Spanish, Persian, Finnish, French, Hindi, Hungarian, Armenian,
Indonesian, Italian, Norwegian, Dutch, Portuguese, Romanian, Russian, Swedish,
Tamil, and Turkish.

In the 30-language fixture set, **Hebrew (`he`), Vietnamese (`vi`), and Khmer (`km`)
fall back to StandardAnalyzer**; no suitable default analyzer is bundled here.
Unknown language codes also use that fallback and report `fallback:true`.
StandardAnalyzer is basic word tokenization, not a claim of morphological support.

## Retrieval contract

A request containing `query` selects retrieval rather than token inspection:

```json
{
  "query": "파란고래우체통",
  "documents": [
    { "id": 2, "text": "파란고래우체국입니다", "language": "ko" },
    { "id": 1, "text": "파란고래우체통입니다", "language": "ko" }
  ],
  "queryLanguages": ["ko"]
}
```

Every request builds and searches its own `ByteBuffersDirectory`. Each document
is indexed in `text_<language>` through that language's default analyzer. IDs
are stored numeric values, not insertion positions; caller order is preserved
for score ties. A caller should vary insertion order independently of relevance
to avoid favoring positives in ties. The optional `limit` defaults to all supplied
documents. Empty document lists and empty analyzed queries return no results.

For ordinary queries, punctuation becomes spaces while Unicode letters, numbers,
combining marks, and underscores survive. Bare AND/OR/NOT/NEAR words are ignored.
Every resulting whitespace-delimited group is analyzed by
`QueryBuilder.createPhraseQuery` separately for every `queryLanguages` entry;
these clauses are joined with OR. A fully quoted input is one phrase group.
The builder enables token-graph handling and position increments, so a group
split into several morphemes is a positional query rather than a bag of OR terms.
Default BM25 uses `k1=1.2`, `b=0.75`. No typo tolerance or prefix expansion is added.

`queryMode:"grouped"` is the default compatibility behavior above.
`queryMode:"analyzed-or"` instead calls `QueryBuilder.createBooleanQuery` with
SHOULD for every unquoted group, allowing its analyzed tokens to match
independently. Explicitly quoted input still uses `createPhraseQuery` in either
mode. The response reports `queryMode` so compatibility and query-compiler
experiments cannot be silently combined.

`queryLanguages` defaults to the languages supplied on documents. Explicit hints
can represent oracle routing, external detection, or analyzer fan-out; the helper
still performs no language detection. Different language fields maintain separate
term/document statistics, so cross-language scores are not equivalent to an
implementation that combines every language's tokens in one field.

Output includes `results:[{id,score}]`, `analyzers`, `fallbackLanguages`, the parsed
`queryGroups`, `quotedPhrase`, and a diagnostic `luceneQuery`. This mode uses
Lucene's actual graph-aware retrieval; the flat-token limitation described above
applies only when an external evaluator uses token-inspection output instead.

## Sources

- [Lucene 9.12.3 common analyzers](https://lucene.apache.org/core/9_12_3/analysis/common/index.html)
- [Nori KoreanAnalyzer](https://lucene.apache.org/core/9_12_3/analysis/nori/org/apache/lucene/analysis/ko/KoreanAnalyzer.html)
- [Maven Lucene metadata](https://repo.maven.apache.org/maven2/org/apache/lucene/lucene-core/maven-metadata.xml)
- [Morfologik module dependency declarations](https://repo.maven.apache.org/maven2/org/apache/lucene/lucene-analysis-morfologik/9.12.3/lucene-analysis-morfologik-9.12.3.pom)

## Matched public-corpus batch reference

`LuceneBatch.java` builds one real FSDirectory per language and corpus level,
then searches every selected topic using QueryBuilder's graph-aware SHOULD query
(or a phrase for fully quoted input). Body and title are separate fields; title
has boost 2. BM25 uses k1=1.2 and b=0.75. Ties use the same deterministic
SHA-256 document ordering as the SQLite study. This reference retains default
language stopwords, normalization and morphology; Swahili uses StandardAnalyzer.

`reference-policy.json` freezes this supplemental reference separately from the
primary nine SQLite methods. The prepared inputs are identical 17-language
10k/100k judgment-augmented pools, with the same audited query selections. Run:

```sh
python3 evals/multilingual-search/lucene-probe/run-batch.py \
  --data-dir /tmp/public-inputs --cache-dir /tmp/lucene-reference-cache \
  --output-dir /tmp/lucene-reference-results --workers 2
```

Add `--baseline-dir /tmp/primary-results` for matched paired intervals, after
verifying both runs use identical input files. Reports retain per-query IDs and
metrics, not document or query text. Each owned scratch index is removed after
its measurement. `test_batch.py` requires `LUCENE_TEST_CLASSPATH` from
`prepare-batch.py` and exercises the actual Java index, phrases, stemming,
stopword-only queries and deterministic ties.

Lucene's per-field document statistics, compressed length norms, graph handling,
stopwords and repeated-query-term semantics differ from the primary SQLite
compiler. A title boost multiplies the saturated field score; SQLite column
weights affect term frequency before saturation. This is a mature search-system
reference, not an isolated tokenizer ablation or raw-score parity claim.

`--export-stopwords PATH --stopwords-only` exports default lexical stopword sets
without running retrieval. Missing APIs are explicitly unsupported; Korean's
part-of-speech filtering is not represented by a lexical stopword list. The
separately frozen SQLite stopword experiment uses these words only on queries,
preserves quoted phrases, and falls back when every token would be removed.

Long research jobs are selected with `[eval:reference]`, `[eval:supplemental]`,
`[eval:public]`, or `[eval:operations]` in a branch push's commit message. Manual
workflow dispatch runs all studies. Native and diagnostic contract checks still
run on every research-branch push, alongside normal repository validation.

<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Exploratory Korean compound follow-up

This is a separate, post-diagnostic hypothesis. A Korean diagnostic miss motivated
it, so it must not be presented as an untouched primary-method comparison or
folded into the primary 17-language macro. Its own public retrieval scores had
not been seen when the [protocol](policy.json) was frozen (SHA256
`fba2ddf0abd76ac6fa51031e5f48630983f0a26d725c86c693a6f4777956efb8`).

The challenger reads existing KoDic compound metadata. It expands stem-lane
components only when their surfaces concatenate exactly to the original token
and safe original offsets exist, without recursive or arbitrary substring
splitting. Its exact lane remains the original precise segmented NFKC/lowercase
analysis. That is **not a guarantee of literal orthographic whole-word matching
in every context**: the original dictionary segmentation can already differ
between a bare word and an inflected sentence. Both limitations and benefits
must be measured.

`compare.py` uses the identical frozen Korean 10k/100k public pools, queries and
all 0/1 judgments. Before any ranking, it asserts full exact-lane document/query
token equality and distinct stem fingerprints. Both variants run fixed OR, AND,
MSM60, exact/stem RRF and exact tiers, importing the primary study's unchanged
analysis, FTS5 indexing and scoring helpers. Each challenger method is paired
with the corresponding original method, with 1,000 bootstrap replicates and
unadjusted 95% intervals. Development-only calibration and no-known-positive
acceptance retain the primary study's qualifications about unjudged background.
No policy is selected on these results.

```sh
KOREAN_BASELINE_PROBE="$ORIGINAL_PROBE" \
KOREAN_COMPOUND_PROBE="$COMPOUND_PROBE" \
KOREAN_COMPOUND_CONTROLS="$EXTERNAL_CONTROLS_JSON" \
python3 -m unittest discover -s evals/multilingual-search/compound-public -p 'test_*.py'
python3 evals/multilingual-search/compound-public/compare.py \
  --data-dir "$EXTERNAL_PUBLIC_DATA" --cache-dir "$EXTERNAL_COMPOUND_CACHE" \
  --baseline "$ORIGINAL_PROBE" --challenger "$COMPOUND_PROBE" \
  --output "$EXTERNAL_COMPOUND_REPORT"
```

The actual CLI/FTS5 controls cover the issue 902 vocabulary with freshly invented
sentences, ticket inflection, partial matches and nonadjacent phrase negatives.
The #902 control preserves an existing successful base phrase path; it does not
claim a new fix for that already-correct frozen-core case. The optional
`KOREAN_COMPOUND_CONTROLS` output records bounded original/challenger term streams
and OR/AND/phrase candidate IDs, with assertion-success flags, using only these
invented fixtures. They also expose adjacent-component matches in the decomposed stem lane while
checking preserved exact-lane whole-word evidence. This avoids claiming that
more aggressive decomposition is automatically more precise. These synthetic
controls are not additional human judgments. Run the heavy public comparison
through the normal admitted research queue or hosted CI.

Reports contain metrics, public IDs, fingerprints, source/binary/data hashes and
counts, never query or passage strings. All text-bearing inputs and analysis
caches remain outside Git. No production default, primary driver or live store
is changed. OR retrieves 1,000 candidates for fusion reuse; metrics use the first 100. These timings are not an isolated production latency comparison.

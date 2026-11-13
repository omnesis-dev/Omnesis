<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Cross-study query exposure audit

The initial NanoMIRACL study evaluated 3,403 queries. The later public study uses
separate official NoMIRACL development/test splits, but split labels alone do not
prove that every question is new. The [frozen exposure protocol](policy.json)
(SHA256 `e034a39b802ecca0cbf11e249b96a05bb464a73f0b59ed107059477904546dcc`)
was written before this audit's counts and before reading the original primary
17-language retrieval outputs. Supplemental/reference aggregate outcomes had
already been observed; the exposure rule uses only identity/text metadata and
never chooses exclusions from retrieval outcomes.

`audit.py` verifies all 18 pinned prior query parquet checksums, then compares the
selected new queries by language-namespaced ID and global normalized text. Text
normalization uses NFKC, case folding and collapsed Unicode whitespace; a second
conservative form retains letters/digits/marks and replaces punctuation/symbols
with spaces. Query strings remain outside Git. Reports contain public IDs,
normalization-match flags, counts and source/text hashes only.

The [observed overlap](observed-overlap.json) contains zero TEST ID overlaps but
six previously exposed positive TEST question texts: five literal and one
format-normalized match, across Arabic, German, Spanish, Hindi and Swahili. This
leaves **4,244 unseen positive TEST queries** and all **4,091 no-known-positive
TEST queries**, with every one of the 17 languages retained. The 633 exposed
positive DEV questions remain explicitly development, not an unseen-held-out
claim. The report preserves the six new-to-prior ID mappings without their text.

```sh
python3 evals/multilingual-search/exposure-audit/audit.py \
  --prior-dir "$EXTERNAL_NANOMIRACL" --data-dir "$EXTERNAL_PREPARED_PUBLIC" \
  --output "$EXTERNAL_EXPOSURE_AUDIT"
python3 evals/multilingual-search/exposure-audit/sensitivity.py \
  --audit "$EXTERNAL_EXPOSURE_AUDIT" --reports-dir "$EXTERNAL_PRIMARY_REPORTS" \
  --output "$EXTERNAL_UNSEEN_SENSITIVITY"
```

The audit requires `pyarrow==23.0.1`. The sensitivity uses the complete original
nine-method per-language reports; it does **not** rebuild indexes, alter query
lists or replace the full experiment. Every method uses exactly the same
metadata-defined unseen TEST cohort. Original full-DEV fitted thresholds are
retained and labelled. Ranking, no-known-positive acceptance and paired 1,000
bootstrap intervals are reported per language and as equal-language macros,
conditional on the unchanged sampled corpora. Run bootstrap processing through
the normal admitted research queue or hosted CI. Show the original 4,250-query
results and the separate 4,244-query sensitivity together. This is not proof
against undetected semantic paraphrase overlap.

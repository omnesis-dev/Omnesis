<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Exploratory French/Persian analyzer profiles

The primary native profile regressed on French and Persian. This follow-up was
selected **after inspecting those outcomes**, so it is explicitly exploratory
and must stay separate from the primary 17-language macro. The
[protocol](policy.json) was frozen before any profile retrieval scores (SHA256
`682844334cfe0983089c337833e2d87a1663163a873ac3a938c48f7cca53acda`).

Three distinct CLI binaries compare unchanged native analysis, finer Charabia
boundaries only, and those boundaries plus scoped language normalization before
Frostem. Only configured French Latin and Persian Arabic spans are eligible;
other scripts/languages and all exact-mode tokens remain unchanged. Unsafe
original-offset mappings fall back to the original token. The adjacent native
prototype directory owns the binaries, transformation controls and their
separate provenance protocol. No frozen core file or primary driver is edited.

`compare.py` reuses the primary disk-backed analysis, FTS5 index, query and scoring
helpers. Its compact comparison scaffold is separately frozen from the prior
Korean study. Every document/query exact-token sequence must match across all
three binaries, and stem fingerprints must be distinct, **before ranking**.
Identical selected questions and all 0/1 judgments run against the same nested
10k/100k pools with unchanged weights, hash ties, five query methods and
per-language development-only calibration. Each challenger is paired with its
corresponding original method, including conditional 1,000-bootstrap intervals.
The equal-weight two-language macro is labelled as this selected cohort.

```sh
python3 evals/multilingual-search/profile-public/compare.py \
  --data-dir "$EXTERNAL_PUBLIC_DATA" --cache-dir "$EXTERNAL_PROFILE_CACHE" \
  --baseline "$ORIGINAL_PROBE" --boundary "$BOUNDARY_PROBE" \
  --normalization "$NORMALIZATION_PROBE" --output "$EXTERNAL_PROFILE_REPORT"
```

Run the actual synthetic token/FTS controls before the heavy public comparison,
through hosted CI or the normal admitted queue. Broader matching can erase
useful distinctions. In particular, shared Persian OR tokens do not prove
semantic negation understanding. The reported normalization metadata is a
first-record snapshot; its `processed_spans` counter is not a corpus total.

Reports contain metrics, public IDs, hashes and configuration, without public
query or passage strings. Text-bearing caches and output stay outside Git.
No threshold, query cohort or winning language policy is selected on these
scores. Show original regressions and every follow-up result together. Additional
fresh confirmation would be needed before treating a selected profile as a
validated general default.

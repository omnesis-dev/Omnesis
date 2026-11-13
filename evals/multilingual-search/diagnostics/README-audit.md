# Post-result audit supplements

The original frozen fixtures and twenty-arm report remain intact. Two additions
are explicitly **post-result** and exploratory; neither changes query text,
required targets, analyzer defaults, numeric thresholds, or original ranked IDs.

`annotation-errata.json` records two demonstrable labeling errors. The Vietnamese
table query also matches two garden records that mention a table. The Spanish
drawer query also matches a potato note that mentions a drawer. These records
become compatible alternatives in a separate overlay. The generic Spanish verb
`revisar` remains an unresolved relevance ambiguity, without automatic relabeling.

Recompute authored and corrected metrics from the exact original rankings:

```sh
python3 evals/multilingual-search/diagnostics/audit.py \
  --input /tmp/diagnostics.json \
  --corrected-output /tmp/diagnostics-authored-vs-corrected.json
```

The driver checks literal fixture evidence and preserves required-target recall,
MRR, and top-one scores. Corrected precision, negative exposure, and condensed
required-target nDCG are reported alongside their original authored values.
Original report hashes and ranked-ID hashes are retained; fixture prose is not
copied into generated ranked result rows.

The original language-lane policy queries only lanes corresponding to selected
query-analysis languages. Consequently it changes the candidate universe as well
as BM25 statistics. Its quality losses cannot be attributed to statistics alone.

`amendment.json` freezes a supplemental **fair-lanes** control before its outputs.
The global arm's exact analyzed query union is searched in every physical lane,
then fused with reciprocal-rank fusion. This restores the same candidate universe
before truncation for supported OR/phrase expressions with the original boundary
sentinels. Per-lane top-100 truncation and fusion can change returned candidates.
Partitioned document lengths and rank fusion also differ, so this still does not
isolate document-frequency statistics alone.

Run the nine additional arms, with authored and corrected relevance aggregates:

```sh
python3 evals/multilingual-search/diagnostics/audit.py \
  --input /tmp/diagnostics.json \
  --corrected-output /tmp/diagnostics-authored-vs-corrected.json \
  --fair-output /tmp/diagnostics-fair-lanes.json \
  --analyzer /path/to/omnesis-multilingual-prototype \
  --detector /path/to/omnesis-fasttext-probe \
  --detector-model /path/to/lid.176.ftz \
  --official-detector /path/to/fasttext \
  --cache-dir /tmp/multilingual-diagnostics-cache
```

Use the host's installed admission wrapper for benchmark runs. The control rejects
changed original implementation hashes, analyzer fingerprints, fixture/policy
hashes, detector model, or document/query routing. A fresh repeat of the original
experiment can differ in timing and binary checksum while retaining the frozen
analysis configuration. Both original audit-report hash and actual input-report
hash are recorded. Supplement tests join the original standard-library unittest
discovery command. No hosted model service, embeddings, or private data is used.

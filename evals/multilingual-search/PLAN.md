# Multilingual full-text search research

The investigation keeps lexical retrieval in SQLite FTS5 and BM25. Its purpose
is to select a language-analysis and query-compilation design on measured
quality, resource cost, integration behavior, and operational safety.

The prototype branch does not change the default production tokenizer or search
query behavior. The generic memory-ranker entry point accepts already-analyzed
terms; only the isolated research adapter uses it for multilingual queries.

## Investigation tracks

1. **Independent relevance evaluation:** frozen development and held-out queries,
   every available positive and explicit-negative judgment, larger nested
   distractor pools, per-language regressions and paired uncertainty. Compare
   precise and broader lexical policies with equivalent query semantics.
2. **Realistic diagnostics:** independently authored synthetic personal-document
   collections, mixed scripts/languages, inflections, exact quotations, names,
   identifiers, URLs, Unicode distinctions and no-relevant-document queries.
   Report native-speaker-review limitations explicitly.
3. **Combined native analysis:** portable ICU4X segmentation, Charabia/Lindera
   language capabilities and pinned stemming behind one versioned API. Test
   actual SQLite custom-tokenizer registration and per-value locales.
4. **Integration:** query compilation shared by SQLite and the memory scorer,
   original offsets, phrase semantics, update following, visibility and document
   restrictions, encrypted reopening, independent workers and stale-cache guards.
5. **Operations:** resumable bounded index-generation builds with interleaved
   writes, validation failure, atomic activation, retained-index rollback;
   progressively larger indexing and query workloads, cold and warm costs,
   complete resource-accounting qualifications.
6. **Decision:** compare contenders by quality, regressions, footprint, latency,
   integration effort and outstanding evidence. Update the illustrated study
   with what actually ran, not just proposed architecture.

## Evidence discipline

- Freeze policy before held-out retrieval scores and keep development tuning
  separate. Post-result observations are exploratory.
- Finding candidates, ranking them well, and rejecting misleading results are
  distinct measurements. Unjudged passages are not confirmed negatives.
- Known-language controls are explicitly identified. Automatic mixed-language
  routing cannot claim the quality of an oracle language hint.
- Store only aggregate measurements, public row identifiers, configurations,
  checksums and invented fixtures in Git. Keep downloaded corpora, model data,
  compiled dependencies, caches and operational logs outside the checkout.
- CI executes on GitHub-hosted runners with a read-only token and no secrets.
  It validates exact source revisions. A failed or incomplete run is not green.
- Prototype code and research adapters remain separate from production schema
  migration and rollout. No live-store migration or service restart is part of
  this research.

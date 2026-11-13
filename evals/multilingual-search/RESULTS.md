# Expanded multilingual lexical search study

The largest measured improvement is a shared multilingual analysis package plus
an analysis-aware query compiler. SQLite remains the durable full-text index;
BM25 remains the ranking foundation. The research branch contains working
native and query-adapter prototypes, not a change to production defaults.

The combined package uses ICU4X 2.4.0, lean Charabia 0.10.0 / Lindera 5.3.0 and
native Frostem 2.20261016.3 Snowball recipes. The comparison arms use Python
Snowball 3.1.1 where specified. Automatic language routing, literal-identifier
policy and production rollout remain distinct integration work.

## Independent public comparison

The frozen primary study uses 17 eligible languages, 4,250 positive TEST queries
with multiple relevance judgments, and 4,091 no-known-positive TEST queries.
Each language has identical nested 10k/100k judgment-augmented, bounded-shard
pools across methods. Known split languages are oracle hints. These are not
full-corpus MIRACL scores or automatic-routing measurements.

| Method                      | 100k nDCG@10 | Recall@100 | MRR@10 |
| --------------------------- | -----------: | ---------: | -----: |
| Current Porter/unicode61    |       0.3324 |     0.6573 | 0.3325 |
| ICU4X + Snowball OR         |       0.4645 |     0.8551 | 0.4525 |
| Full Charabia + Snowball OR |       0.4830 |     0.8828 | 0.4718 |
| Lean Charabia / ICU4X OR    |       0.4809 |     0.8812 | 0.4693 |
| Combined native analysis OR |       0.4782 |     0.8805 | 0.4663 |
| Lucene default pipeline     |       0.4374 |     0.8050 | 0.4582 |

The combined native-minus-current nDCG difference is **+0.14575**, with an
unadjusted paired 95% bootstrap interval **[+0.13691, +0.15453]**. This is a
ranking-score improvement, not a percentage of users whose searches succeed.
Native OR improves the nDCG point estimate in 12 languages and regresses in five.
French and Persian have clear negative paired intervals; English, Spanish and
Swahili intervals include zero. These regressions are rollout blockers to
resolve, not grounds to declare all languages solved.

At 10k, current/native nDCG is 0.4215/0.5726 and Recall@100 is 0.7478/0.9453.
Requiring every analyzed term reduces 100k recall to 0.0147; a fixed 60% minimum
reduces it to 0.4827. Generic surface/stem RRF scores 0.4609 nDCG, and fixed
surface-first tiers 0.4757. Broad retrieval, phrase intent and precise evidence
need separate policies; blindly requiring more words or fusing lists is not a
universal improvement.

The quality harness encodes CLI-analyzed terms into ordinary SQLite FTS5 so its
test tokenizer cannot reinterpret them. The native encrypted adapter is tested
separately through the supported locale-aware tokenizer API. The entire public
study did not run through the encrypted gateway, and its AND/MSM/fusion policies
are not all implemented in the native adapter. Ordinary unique-OR and explicit
phrase contracts are aligned; this encoding is an evaluation technique, not the
proposed production representation.

Lucene is a whole-pipeline reference with default stopwords, token graphs,
per-field statistics, compressed norms and different title/repeated-term
semantics. Its result does not isolate an engine or tokenizer effect. The native
minus Lucene 100k nDCG difference is +0.04073 [0.03078, 0.05150]; the MRR
interval includes zero. No JVM/index migration is justified by this comparison.

## Data integrity and exposure audit

Yoruba was excluded before primary scores because its supplied NoMIRACL labels
were contaminated. Chinese legacy passage IDs were repaired against official
judgment dictionaries, and missing required passages recovered with an explicit
integrity amendment. All original and amended hashes are retained.

A separate metadata-only exposure audit found no overlapping TEST IDs but six
question-text duplicates from the initial NanoMIRACL study. All methods retain
the original 4,250-query report. The separate **4,244-unseen-query** sensitivity
keeps all 17 languages and produces current/native nDCG **0.332675/0.478218**,
with paired gain **0.145543 [0.137053, 0.154106]**. The conclusion survives this
exclusion. Development exposure is disclosed and is not an unseen-test claim.
Unknown semantic paraphrases cannot be ruled out by this audit.

The initial 18-language, one-positive NanoMIRACL study is retained in
[README.md](README.md) and [findings.json](findings.json). Its scores must not be
subtracted from these larger multi-positive-pool scores.

## What extra tools add

Query-only default stopword filtering changes 100k native nDCG from 0.47818 to
0.48150, a paired gain of 0.00333 [0.00062, 0.00593]. Recall change is uncertain.
Quoted queries remain intact; all-stopword queries fall back to the original
query. Empty/unsupported lexical sets and Korean POS-filter differences are
explicit. This is a modest refinement, not the main integration lever.

On the matched 11-language 10k cohort, Simplemma 2.0.0 lemma-only nDCG is 0.59517
versus native 0.59294, with an interval including zero. Stem/lemma fusion reaches
0.60022: gain 0.00728 [0.00282, 0.01161], with modest recall gains but another
runtime/dictionary/lane and weak abstention. These 11-language means are not
comparable directly with the 17-language means. Python lemmatization is not a
mandatory production dependency recommendation.

Scores do not reliably decide whether useful material exists. Native OR's
balanced relevant/no-known-positive test acceptance is about 0.513 at the
per-language development-fitted thresholds. The exact tier's low apparent false
acceptance also rejects most positive-query opportunities. RRF scores can become
nearly constant and must not be interpreted as confidence probabilities.
Unjudged background passages may be relevant, so no-known-positive acceptance is
an apparent measure, not a verified global error rate.

## Dictionary compound follow-up

The frozen package resolves issue 902's attached-ending example. A different
Korean word, 승차권, has inconsistent whole-word versus suffixed decomposition.
Normal/decomposition mode switches do not repair it, but the dictionary already
lists its compound constituents. A separate challenger expands only verified
concatenative Compound metadata, with safe original offsets, in the broad lane.
The precise exact stream remains unchanged over all prepared documents/queries.

On the unchanged Korean 100k pool, OR nDCG improves **0.39243 → 0.42893**, gain
**0.03650 [0.01529, 0.05722]**; recall improves **86.71% → 91.21%**. The public
baseline reproduces the primary Korean results exactly. Fresh controls preserve
the existing issue 902 success and expose adjacent-component precision risks.
This is a post-diagnostic Korean-only exploratory comparison, outside the
original 17-language macro, not a general token-graph implementation.

## French/Persian preprocessing follow-up

The separate boundary-only and language-normalization profiles keep every exact
stream unchanged and use existing Charabia rules before Frostem. They apply
only to configured French Latin/Persian Arabic stem spans. All 14,000 baseline
query evaluations reproduce the primary study; 17 fresh control checks pass.

| Language / 100k OR | Original native nDCG | Boundary only | Boundaries + normalization |
| ------------------ | -------------------: | ------------: | -------------------------: |
| French             |               0.4033 |        0.4389 |                     0.4518 |
| Persian            |               0.4775 |        0.5138 |                     0.5226 |

Normalization-profile gains versus native are +0.04853 [0.02449, 0.07694] for
French and +0.04512 [0.02228, 0.06818] for Persian. Boundary-only changes account
for most of the selected two-language point gain; no direct boundary-versus-norm
interval is claimed. These restore the observed regressions near full-Charabia
quality without another library/runtime dependency. Selection followed inspection
of the primary test regressions, so this is explicitly exploratory evidence,
not independent confirmation or a stitched new 17-language macro.

Curly apostrophes/elision, ligatures and optional marks expose rule-order issues.
Persian halfspaces and digits have different treatment across analyzers; common
Arabic kaf/yeh variants were already handled by Snowball. Lossy normalization can
merge distinct French accents, and Arabic-script segmentation can split
article-like prefixes in Persian names. Precise streams remain available, but
calibration/precision are not automatically solved. These CLI wrappers include
redundant baseline computation and do not establish optimized integration cost.
The compound and preprocessing profiles still need integration into the shared
native FTS5 package; the frozen extension's measured footprint/cost is separate.

## Authored mixed-language diagnostics

Each development/held-out collection contains 143 invented documents and 140
queries across 30 languages. Mean bodies are about 190 characters; 92 of 137
required-target queries are code/URL/quote controls. No native-speaker review was
available. These are structural diagnostics, not population accuracy estimates.

After transparent compatible-alternative corrections affecting two queries and
three documents, surface-priority stem plus broad script-compatible fanout gives
held-out condensed required-target nDCG 0.9256, required MRR 0.9392 and required
Recall@100 0.9562, with negative exposure in 2/140 queries. The controlled
five-field Porter baseline gives 0.6933/0.6740/0.7883 and 65/140 negative-exposure
queries. This is not the deployed two-field baseline or the public nDCG metric.
On 30 morphology controls, top-10 target recovery improves 11→26; minority
paragraph recovery improves 1/7→6/7.

The original language-lane arm also gated candidate languages. A separate fair
control searches the same query union across all physical lanes. It restores
candidate reachability, but surface-priority nDCG is 0.9219 versus global 0.9256,
with identical required Recall@100. Length statistics, truncation and fusion
remain confounded; this is not pure IDF isolation or evidence for physical
per-language index complexity. Broad fanout generates 2,346 variants per 140
queries and is not a validated bounded product default.

Same-script English/Spanish mixing, Arabic broken plurals and Hebrew attached
forms still expose misses. Greek ticket/book pairs fail under both our stemming
and Lucene's Greek analyzer in a separate 20-word post-audit check. Sampled raw
Frostem/Python parity is perfect on 7,200 words across 36 algorithms; that proves
sampled implementation agreement, not complete linguistic coverage.

## Native integration and operations

The combined baseline extension passes **24 encrypted-store lifecycle checks**
on Linux x64 and macOS arm64, plus core/challenger Rust suites (34 executions
across four test targets), 45 memory-ranker tests, 140 bounded Unicode controls,
and 2,574 compiled-term/offset round trips over 712 inputs in 30 languages.
The checked analysis and token-stream hashes agree across both platforms.

The extension uses the supported FTS5 locale-aware tokenizer API (SQLite 3.47+;
measured encrypted build 3.53.4), per-value language hints, original offsets and
query-only pass-through markers for already-analyzed terms. It checks updates,
deletes, restrictions, visibility, independent workers and stale generations.
A bounded native generation can resume, validate, activate and retain rollback
while writes continue. The initial isolated installer still rebuilds in one
transaction; a bounded first populated-Porter production migration remains work.

After ordinary-query deduplication aligned the adapter with the frozen unique-OR
quality policy, operational measurements were rerun at `ccbb13e54`:

| 250k mixed chunks | Index time | Encrypted store | Base ranking arrays | Peak whole-process RSS |
| ----------------- | ---------: | --------------: | ------------------: | ---------------------: |
| Current           |     167.8s |       318.90MiB |            89.29MiB |              935.98MiB |
| Combined stem     |     202.3s |       313.33MiB |            84.03MiB |              949.30MiB |
| Combined precise  |     199.7s |       318.44MiB |            91.35MiB |              988.89MiB |

All nine 10k/100k/250k trials complete, with **306/306 fresh-cache candidate-order
checks** matching SQL. The ordinary unrestricted-query fallback count is zero;
phrases are not timed, and restrictive document-ID queries use SQL outside that
count. After updates, **25/72** checked orders differ under the existing
approximate incremental statistics; relevance impact is not measured.

At 250k, stem/current aggregate warm SQL p95 is 57.78/139.19ms and memory p95 is
2.71/4.06ms. On 23 queries where both methods recover a known positive in the top 20 and
return the same number of results, the median per-query SQL latency ratio is 1.607 (stem slower), versus
0.681 in memory. Equal returned counts do not control all posting work. There is
no universal latency win. Fresh-process opening is about 150ms; one native
Korean SQL query then takes 195ms versus current 20ms. OS caches are uncontrolled
and the memory cache is not rebuilt in that cold measurement.

RSS includes Node, loaded raw inputs, dictionaries, SQLite, arrays and build
scratch. The benchmark uses nonshared builds while production workers use
shared arrays, so this is not a production memory estimate. Language hints are
provided; detector inference and uncertain-query fanout are excluded. These
single-index trials do not measure simultaneous precise/stem/literal indexes or
peak pending/retained migration storage. Historical `55ea48108` results remain
separate and do not isolate a causal timing benefit from query deduplication.

The measured Linux core plus adapter occupies 89.20MiB uncompressed /22.87MiB
per-file gzip6; macOS is similar. The optional CLI can duplicate embedded data;
models/detectors and database/RAM are separate. Final redistribution still needs
complete library/dictionary/model notices and target-platform validation.

## Implementation direction

1. Integrate one versioned analysis component with supported locale-aware FTS5,
   a shared query representation and cache analysis. Keep raw chunks intact.
2. Preserve surface and literal identifier/URL evidence; intentional phrases
   retain positions. Select broad matching by development evidence, with
   per-language ranking/recall/precision gates.
3. Evaluate dictionary constituents and explicit language preprocessing profiles
   as capabilities, not word-specific suffix repairs. Bound uncertain-query
   alternatives and keep language guesses separate from document visibility.
4. Implement the first populated-store migration, production writer scheduling,
   worker registration, startup and packaging; define incremental-statistics
   accuracy/rebuild requirements and prefix/typeahead semantics.
5. Validate with native speakers, longer representative documents, target
   platforms and a longer concurrency/crash-recovery soak before changing defaults.

See [the native API](prototype/README.md), [integration](integration/README.md),
[public policy](extended-public/README.md), [diagnostic audit](diagnostics/README-audit.md),
[exposure audit](exposure-audit/README.md), [compound follow-up](compound-public/README.md),
[preprocessing profiles](profile-public/README.md), and [Lucene reference](lucene-probe/README.md)
for exact contracts, frozen inputs and reproduction commands. Reports retain
versions, hashes and public IDs; downloaded text, models, binaries and caches
stay outside Git. No live store, service, production default or release was changed.

<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Search eval

A public multilingual retrieval benchmark run through the real Omnesis search
engine. It answers one question: when the search code changes, does search get
better or worse, and in which languages?

The numbers are in [RESULTS.md](RESULTS.md). The raw record of every run is in
[`results/`](results/).

## What is measured

The dataset is the development split of [MIRACL](https://project-miracl.github.io/):
Wikipedia passages in 18 languages, questions written by native speakers, and
human judgments of which passages answer each question.

MIRACL's full corpus is about 90 million passages, so each language gets a
bounded pool: every passage judged for any of its questions, plus a
deterministic uniform sample of the rest of that language's corpus, up to
100,000 passages. A language with a smaller corpus contributes all of it.

A run boots an isolated gateway from the checkout, pushes every pool into it as
ordinary documents in one source, waits for indexing to finish, and sends each
question to `POST /search`. Nothing is stubbed. All languages share one index,
as they do in a personal corpus, and every question searches all of it.

The gateway ranks keywords with an in-memory index that it rebuilds in the
background, and with SQLite FTS5 until that index covers the corpus. A run waits
for the in-memory index after the bulk load, because that is what a settled
install serves from, and records how many queries each ranker answered: a query
the in-memory ranker cannot serve still falls back.

Four scores are reported per language, and as a macro average in which every
language counts equally:

- **Hit@10** is the share of questions with at least one relevant passage in
  the first ten results. It is the score to watch when the reader of the
  results is an agent, which reads the whole first page and takes what it
  needs from it.
- **nDCG@10** rewards relevant passages near the top of the first ten results.
  1 is a perfect ranking. This is MIRACL's headline score.
- **Recall@100** is the share of a question's relevant passages found anywhere
  in the first hundred results.
- **MRR@10** is one over the rank of the first relevant passage in the first
  ten, or zero.

A run has one of two modes:

- `lexical` assigns no embedding model, so the result is keyword search alone.
  Use it to judge changes to tokenization, stemming, query compilation and
  keyword ranking.
- `hybrid` adds one embedding model, served on the same machine, so the result
  is what a user with semantic search gets.

## How to read the scores

Compare runs with each other and with nothing else.

- Every judged passage is in its pool, and the 18 pools together hold about 2%
  of the full corpus. Scores are therefore higher than published full-corpus
  MIRACL scores and not comparable with them.
- A passage nobody judged counts as not relevant, though some are. This lowers
  every run alike.
- Wikipedia passages are not mail, chat or notes. The eval says how well each
  language is handled, not how good search is on a personal corpus.
- A score is not the share of searches that succeed.

A run changes two settings from the gateway's defaults, and records them. The
candidate pool (`search.params.candidateLimit`) is raised from 50 to 100 so that
Recall@100 can be measured. The temporal lane (`search.temporal.enabled`) is
off: it reads a question's dates against the day of the run, and every passage
carries the same date, so with it on a score would change from one day to the
next.

## Running it

Everything runs on the local machine. The dataset is downloaded once from the
Hugging Face hub; after that a run makes no network request beyond loopback. The
hybrid mode refuses an embedder address that is not loopback, and the eval
never assigns a chat or agent model.

```sh
# Once: stream the MIRACL corpus from the hub and build the pools (1.1 GB kept).
npm run search-eval:prepare

# Keyword search only. A little over an hour for all 18 languages on a fast machine.
npm run search-eval:run -- --name my-change-lexical

# Keyword + semantic search, with a local OpenAI-compatible embedder.
npm run search-eval:run -- --name my-change-hybrid --mode hybrid \
  --embedder-url http://localhost:8001 --embedder-model Qwen/Qwen3-Embedding-0.6B

# Rebuild RESULTS.md, and compare two runs query by query.
npm run search-eval:report
npm run search-eval:report -- --compare baseline-lexical my-change-lexical

# For a hybrid run: how the keyword and semantic lanes do alone, beside the fused results.
npm run search-eval:report -- --lanes my-change-hybrid
```

The dataset lives outside the repository, in `~/.cache/omnesis-search-eval` or
wherever `OMNESIS_SEARCH_EVAL_DATA` or `--data-dir` points. The gateway's
databases for a run are created under `work/<run-name>/` there and removed when
the run ends; a run that was killed leaves them, and the next run of that name
clears them. `--languages ko,ja` and `--max-passages` / `--max-queries` make a
quick partial run, which the results page marks as partial; give it a throwaway
name and do not commit it.

A run refuses a checkout with uncommitted or untracked changes, because its
record names the commit it measured; `--allow-dirty` lifts that for a throwaway
run. Recorded runs are not part of what is measured, so several runs can follow
one commit before their results are committed. The record also holds the tree
of `packages/` at that commit, which identifies the measured code after a
squash merge has replaced the commit. A run does not replace a recorded run of
the same name without `--force`.

## Deciding with it

1. Make the change in the product code.
2. Run the mode it affects under a new name.
3. Compare with the baseline. The comparison pairs the two runs query by query
   and gives each language's change with a 95% bootstrap interval. An interval
   that excludes zero is a real change; one that spans it is noise. Runs on
   different languages, pools or caps are refused.
4. Commit the run's two files and the regenerated `RESULTS.md` with the change.

A run is kept as a record of what a commit scored. Replace the baseline only
when the default search behaviour changes.

## Files

| Path                        | What                                                      |
| --------------------------- | --------------------------------------------------------- |
| `src/prepare.ts`            | Downloads MIRACL at pinned revisions and builds the pools |
| `src/run.ts`                | The bridge: gateway, ingest, index, query, score          |
| `src/report.ts`             | `RESULTS.md` and the paired comparison                    |
| `src/metrics.ts`            | The three scores and the bootstrap                        |
| `results/<run>.json`        | A run's summary: commit, mode, settings, scores, timings  |
| `results/<run>.queries.tsv` | One row per scored query: its scores and each lane's rank |

## Dataset licence

MIRACL is published under Apache 2.0 and its text derives from Wikipedia
(CC BY-SA). None of it is redistributed here: the repository holds scripts,
scores and public query identifiers only.

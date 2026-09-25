<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 Adrien Conrath
-->

# `@omnesis/watch`

A watch monitors your digital life against a predicate. This package holds the
predicate language a watch compiles to, the validator that checks one, the
engine that runs one, and the compiler that writes one from a request in plain
words.

It is deliberately **standalone**: it imports nothing from the gateway. What it
knows about the world arrives as data, so the language and the engine can be
proven against a fixture universe long before anything is wired into the
product. Two guard tests (`src/package-boundaries.test.ts`) keep it that way:
no gateway import, and no clock read anywhere in `src/`.

## What is here

| Module              | Owns                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `dsl/schema.ts`     | the DSL as zod schemas — **shape**. TypeScript types are derived, never hand-maintained.                                       |
| `dsl/expression.ts` | the restricted expression language used in `output_map`, key extractors, and `fire_when`.                                      |
| `dsl/value-type.ts` | the types that flow along DAG edges, and what "compatible" means between two of them.                                          |
| `ontology/`         | the ontology snapshot: source document profiles, the analytics catalog, and the people directory.                              |
| `validator/`        | (watch, ontology) → machine-readable diagnostics — **meaning**.                                                                |
| `time/`             | durations (including business days) and the recurring-schedule surface, both evaluated from a passed-in instant.               |
| `runtime/`          | the engine: journal consumer, node engines, state store, virtual clock, and the scripted judge and recall ports.               |
| `backtest/`         | replay a watch with judges stubbed to counters — what the cheap half did, and what finishing it would cost.                    |
| `compiler/`         | a request in plain words → a validated watch, or a refusal with reasons. The validator and the backtest are its feedback loop. |
| `eval/`             | measuring the compiler: two request sets, behaviour-equivalence scoring, a failure taxonomy, and a spend ceiling.              |
| `journal/`          | the event contract the runtime consumes, and the reader that refuses anything that is not one.                                 |
| `universes/`        | fixture worlds: an ontology snapshot, the watches, the invalid-DSL goldens, and the frozen traces.                             |
| `internal/`         | own-property lookup for every table indexed by a name that came out of a watch document.                                       |

## The DSL in one paragraph

A watch is a DAG. **Source nodes** are trip-wires fed by a durable event
journal — a document event, an analytics row, an open-loop change, a timer.
**Stateless nodes** (OR, transform) evaluate the instant an arm fires.
**Stateful nodes** (wait, AND, N-of-M, sequence, cooldown, persistence, and the
SQL and LLM nodes in their stateful forms) hold an instance between arm and
fire, and must say what a colliding arm does. Signal flows downstream only, to
exactly one **sink**; when the sink fires, the watch fires. Every node carries a
typed structured output alongside its fired/not-fired signal, and every
reference into one is checked before the watch is ever run.

Two rules shape most of the design. SQL nodes read the **analytics store only** —
the document store is an internal representation, not a queryable contract, so
document and cognitive data reach a watch through typed source nodes instead.
And **no node reads a clock**: the evaluation instant arrives as the bound
parameters `$today` and `$now`, which is what makes a backtest replay time
rather than approximate it.

## Validating a watch

```ts
import { loadOntology, validateWatch } from "@omnesis/watch";

const result = validateWatch(watchJson, loadOntology());
for (const d of result.diagnostics) {
  console.log(d.severity, d.code, d.path, d.message, d.details);
}
```

Diagnostics are an **API, not error prose**. Their primary consumer is
`compiler/`, which reads a failed validation and rewrites the DSL, so each one
carries a stable code, a JSON Pointer at the offending location, and a `details`
payload naming what was expected — the declared metadata fields, the known table
names, the legal collision modes. Nothing should parse the message.

## The fixture universe

`universes/poc/` is the world everything here is checked against:

- `ontology.json` — the declared world. Structurally identical to what
  `source_document_profiles` and the analytics catalog hold on a live install,
  so integration swaps a file for two queries and changes nothing else.
- `watches/` — the twelve worked examples the language was designed against,
  plus five more that exist only to reach node types the twelve happen not to
  use. Each carries the request it was written from, in `nl_query`; that is what
  makes the corpus usable as the compiler's worked examples, and what makes a
  compilation of the same request a measurement rather than a lookup. A node type with no working example is a node type nobody has proven the
  language can express, and a test derives that check from the schema so a new
  node type cannot arrive without one. All of them must validate with zero
  errors.
- `invalid/` — one watch per way of being wrong. Each is asserted twice: against
  a hand-written list of the codes it must produce, which is the independent
  oracle, and against a frozen `ValidationResult`, which pins the whole payload
  so a message that stops naming what was expected shows up as a diff. The
  corpus also pins that **every** declared diagnostic code is reachable, so the
  code list cannot drift into advertising checks that no longer exist.

- `traces/` — one frozen trace per watch: the ordered
  `(seq, node, key, transition)` records, the firings they end in, and the
  backtest's reach counts. A trace rather than a verdict, because "the watch
  fired" says nothing about _why_.
- `scripts/` — what a judge and a recall scorer answer, per watch, so a trace is
  reproducible. The procedural half is exercised in full; what a model would
  decide is written down rather than asked.
- `loops.json` — the open loops a compilation can bind by id, as they stood when
  the replayed window opens. A live install queries the loop store for this; the
  journal then moves them, which is the same staleness a compile-time binding
  always carries.

## Backtesting

```ts
import { backtest, formatReport } from "@omnesis/watch";

console.log(formatReport(await backtest("important-email-unanswered")));
```

A backtest runs the identical engine with every LLM node — including the
precision judge embedded in a semantic-match source — replaced by a counter that
never fires. The recall pass still runs, because embeddings are cheap and
because recall is exactly the filter whose selectivity is in question.

The output is two numbers rather than one verdict: how often the procedural part
fired, and how often it reached a model. The second is the cost, and it is what
pushes a compiler toward cheap pre-filtering — a watch whose structural filter
is "any email from this account" reaches the judge on every one of them.

Every person, address and identifier in the fixtures is invented. Nothing here
is drawn from a real corpus.

## Compiling

```ts
import { compile, examplesFor, loadLoops, modelFromEnv } from "@omnesis/watch";

const result = await compile(
  "Tell me if I spend more than £150 in a day on my card.",
  { ontology, loops: loadLoops(), examples: examplesFor() },
  modelFromEnv(),
);
```

A request in, a validated watch or a refusal with reasons out. The loop is one
attempt, then the validator's diagnostics fed back as machine feedback for up to
three repairs, then a backtest, then at most one revision on the reach report —
a watch that never fires, or that puts every event in front of a model, is
usually a misreading rather than an illegal plan, and the validator cannot tell.
The watch that already validates is the floor: a revision that comes back
illegal or unreadable leaves it standing.

Refusing is a correct answer. Some requests name data no source produces, a
field the substrate does not retain, or a state the loop model does not have,
and a watch written anyway would validate cleanly and watch the wrong thing.

The prompt is split by what each half is good for. **Shape** is generated from
the same zod schema the validator runs, so the two cannot disagree. **Meaning**
is hand-written, because nothing in a JSON Schema can say that a broadcast edge
occupies no slot in an AND. Worked examples are the corpus watches themselves,
paired with their `nl_query`; `examplesFor` takes names to withhold.

The model is a parameter. `modelFromEnv` builds one from
`WATCHV2_COMPILER_BASE_URL`, `_API_KEY` and `_MODEL` — there is no default
endpoint and no credential in the tree — and every test in this package uses a
scripted model instead, so nothing here reaches the network. To try one request
against a live model:

```
npx tsx packages/watch/scripts/compile-watch.ts --withhold <name> "<request>"
```

## Measuring the compiler

```
npx tsx packages/watch/scripts/eval-compiler.ts --only <id> --samples 1   # smoke first
npx tsx packages/watch/scripts/eval-compiler.ts --samples 5 --out report.md
```

A single pass proves nothing: a near-miss compilation fails randomly per
attempt, so every request is attempted several times and reported as a rate.

Two sets. The **paired** set is each corpus watch's own `nl_query`, scored
against what the hand-written watch does — with that watch withheld from the
prompt, so it measures reconstruction rather than recall. The **unseen** set has
no reference, and its point is the requests that should be _refused_: this
ontology cannot answer them, and a compiler that answers anyway has written
something the validator accepts and that watches the wrong thing.

Scoring is by behaviour. Two watches that select the same moments out of the same
journal are the same watch whatever they called their nodes, so the comparison is
the sink firings — sequence, instant, key values — and the sequences at which a
model was reached. Key _values_ rather than names: `thread_id` and `thread` route
identically. The replay agrees with every judgement rather than counting them,
because a judge that never fires makes everything below it unreachable, and a
watch missing its cancel would then replay identically to one that has it.

The taxonomy separates how an attempt failed, because the classes are different
work: a reply that would not parse, a watch that never validated, a watch that
validated and behaves differently, and a watch written for a request that had no
answer. The last two are reported together on their own line — the validator was
satisfied and the answer was wrong, and nothing downstream catches that.

Spend is tracked from the provider's own token counts, priced separately for the
part of the prompt that hit its cache, and the ceiling is checked before each
attempt so a run stops below the number rather than discovering it went over.

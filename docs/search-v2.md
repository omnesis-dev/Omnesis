# Agent search v2

Agent search v2 is an opt-in backend projection of the existing search pipeline.
Enable it in `omnesis.json`, then restart the gateway:

```json
{
  "search": {
    "v2": {
      "enabled": true
    }
  }
}
```

Omitting the block, using an empty block, or setting `enabled` to `false`
preserves the existing search behaviour and retrieval guidance. This switch is
independent of experimental mode. It changes unrestricted built-in agent and
Direct searches, including each `search_many` query. Source-restricted grants
keep their existing projection. The ordinary public `/search` endpoint and all
user interfaces keep their existing contracts and behaviour.

## Grouped content and evidence

Eligible file and attachment candidates with equal, meaningful extracted text
share one ranked result and one matching snippet. Authored messages and emails,
empty or low-signal extractions, similar documents and canonical URL aliases
are not grouped as identical content. The first representative in the existing
ranking order is retained; graph connectedness does not change relevance scores.

Each grouped result retains a bounded inventory of known copies, including
document IDs and available source/app URLs. Locations with supported device
provenance include a device label and display path. A cloud source's collector
is not evidence that the file is stored on that collector's computer. Local
paths remain display information; they do not create an actionable `file:` URL.

The strongest results additionally carry compact, deterministic prose and
directed paths through sparse document connections. The summary is generated
context, separate from source text. Paths retain the document IDs needed to fetch
or cite their evidence. People are terminal role-labelled context; the walk
never expands through a person into their other documents. High-degree document
neighbourhoods stop expansion. Phone matches, model citations and near-duplicate
similarity do not bridge the automatic walk.

Equal extracted text does not prove equal file bytes. A location or link does
not prove download direction or original sharing. Sender/author/recipient roles
are reported only when the graph records them. Fetch the decisive source body
when the question needs content beyond the supplied snippet and provenance.

## Budgets and completeness

All values below are optional. The limits apply per returned result; only
`topN` results receive the deeper graph projection.

| Setting           | Default | Accepted range |
| ----------------- | ------- | -------------- |
| `topN`            | 3       | 1–10           |
| `maxDepth`        | 4       | 1–5            |
| `fanout`          | 6       | 1–12           |
| `maxNodes`        | 24      | 1–48           |
| `maxCopies`       | 8       | 1–24           |
| `maxSummaryChars` | 700     | 100–2000       |

Copy discovery uses the extracted-hash index, including matching documents
outside the ranked candidate pool. Degree reads probe at most one distinct
neighbour beyond the fanout allowance; sparse relation reads have a separate
ceiling proportional to that allowance and the supported edge types.
Copy families do not consume graph hops. Node,
path, string and summary ceilings bound the emitted context.

`provenance.truncated` and `stopReasons` report hub, depth, node, copy and summary
limits. The result describes observed evidence within those budgets, not a
complete digital history. Hidden system sources and the current conversation
are omitted. Index/source revision disagreements do not produce copy claims.

## Compatibility and validation

`provenance` is an optional additive field on the existing document-reference
shape. Tool names, arguments, result kinds, representative IDs, snippets and
existing URL fields retain their contracts. Legacy clients can ignore the new
field; current clients can consume results without it. No new client handshake,
database migration or reindex is required. Disabling the flag restores the
existing projection.

The `graph-search` synthetic universe supplies file copies, versions, a sharing
trail, a reference hub and unrelated activity by the same person. Replay
conversations execute live search and document tools rather than returning
recorded search payloads. The end-to-end suite verifies real ingestion, graph
resolution, context reduction, source restrictions and flag-off/public-search
compatibility. Unit tests exercise adversarial extraction, paths, budgets and
cross-version wire decoding.

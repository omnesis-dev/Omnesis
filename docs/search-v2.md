# Agent search v2

Agent search v2 is enabled by default for unrestricted agent search. It groups
matching extracted text and adds bounded graph evidence. To restore the legacy
projection or compare the two behaviours, set this in `omnesis.json` and restart
the gateway:

```json
{
  "search": {
    "v2": {
      "enabled": false
    }
  }
}
```

Omitting the block, using an empty block, or setting `enabled` to `true` uses v2.
An explicit `false` preserves the legacy agent search projection. The agent
prompts, the retrieval playbook and the `trace_connections` description follow
the switch: with v2 they describe graph context, and with v2 off they describe
the legacy `refCount` and `breadcrumb` cues. This switch is
independent of experimental mode. It changes unrestricted built-in agent and
Direct searches, including each `search_many` query. Source-restricted grants
keep their existing projection. The ordinary public `/search` endpoint, normal
CLI search and mobile interfaces keep their existing contracts and behaviour.

## Inspecting graph context in portal search

When v2 is enabled, operator portal sessions with both read and admin access
see a bullet list of additional facts beside matching search results. Matching
text copies exclude the current document; up to five linked titles are shown
inline, followed by the number of other listed copies. A one-document inventory
has no copy fact. Connected paths use ordinary relation phrases and join real
continuations with “which”. Clauses about the same exact document can share a
sentence; separate paths never manufacture a new connection.

References open in the portal and show a vertically centered source icon before
the title. Document IDs, internal edge codes and numbered traversal steps are
not displayed. There are no section headings or collapsed connections. A result
with no additional copy, connection or device/path information has no extra
panel. Original sources can be opened from the document page. Ranking, snippets,
facets and pipeline diagnostics remain unchanged; the portal supplements them
using the canonical operator agent-context projection.

`GET /search/readiness` advertises `agentContextAvailable: true` only when that
projection is enabled and the caller can use it. Missing capability metadata,
older gateways and read-only sessions retain ordinary search. A failed graph
diagnostic never prevents ordinary results from appearing. Graph context is
fetched afresh for the completed query rather than restored from the search cache.
Agent tool-call cards and mobile search do not gain this panel.

## Inspecting agent context from the CLI

Use the explicit CLI diagnostic projection when v2 is enabled:

```sh
omnesis search "contract" --agent-context
omnesis search "contract" --agent-context --json
```

Pretty output shows the generated summary, available copy locations, device
labels, document IDs and source/app URLs. JSON output is the canonical
`search.results` tool result with document references and optional provenance.
This is useful for inspecting the context the agent receives; ordinary
`omnesis search` continues to use public search.

The diagnostic calls `POST /admin/search/agent-context` with `text` and `limit`.
The route requires operator credentials with both read and admin scopes;
principal OAuth grants cannot use it. It exists only when `search.v2.enabled` is true. When a gateway does not offer it (HTTP 404 or 405),
the CLI falls back to ordinary search and writes a notice to stderr. JSON stdout
remains valid and carries the legacy public-search shape after fallback.
Authentication and other server failures are reported rather than downgraded.

## Model presentation

Unrestricted built-in agents receive graph context as readable `facts`, a
`documents` reference table, and explicit `limits`. Short labels such as `[D2]`
are shared across one query's results, so a document carries the same label in
every hit that names it; they restart for each query of a `search_many` call.
When a connected document is itself a result, the hit says so: `Also in these
search results: [D4] (result 2).` The table resolves each label to its real
document ID, title, source, available links, creation time (to the minute, UTC)
and document type. These labels are not accepted as tool arguments: fetching or
citing uses the table's `documentId`.

`refCount` on an agent search hit is the number of distinct visible documents
that link to it over the structural links the walk follows — conversation
membership, hidden sources and Omnesis-generated documents aside — and is absent
when that number is zero.

Facts exclude the representative from the list of other text matches, attach
physical locations and person roles to their exact documents, and combine only
actual directed path continuations. Traversal limits are explained in prose.
Facts share the configured summary character budget and omit whole sentences
rather than truncating a relationship halfway through.

Canonical results retain the optional `provenance.modelContext` alongside the
existing summary, copies and paths. All model backends project that context
instead of repeating those representations, for both fresh tool results and
restored conversation history. Stored transcripts, client contracts and tool
cards retain canonical results. Old results without this optional context use
their original model serialization. Direct MCP preserves its canonical structured
payload for compatibility, including the additive readable context; external
clients decide how to present that payload to their models.

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

The strongest source results additionally carry compact, deterministic prose and
directed paths through sparse document connections. The summary is generated
context, separate from source text. Paths retain the document IDs needed to fetch
or cite their evidence. Optional `relations` phrases explain each connection in
ordinary language alongside the existing technical `edges`; older paths without
phrases remain valid. People are terminal role-labelled context; the walk
never expands through a person into their other documents. High-degree document
neighbourhoods stop expansion. Phone matches, model citations and near-duplicate
similarity do not bridge the automatic walk.

A conversation is read from the thread itself rather than through its stored
thread links, which point each message at an arbitrary member. The thread counts
as one neighbour against the fanout allowance and contributes its newest other
messages, up to that allowance, so a short conversation appears whole and a
long one by its newest messages. The first fact names the newest message and the
conversation's size (`is in a 12-message conversation whose latest message is …`),
or says the hit is itself the newest (`is the latest of 12 messages in a
conversation that also has …`). Membership comes from the `threadId` (or
`conversationId`) a source declares, so it holds for documents indexed before
this behaviour existed. Leaves sharing a relation read as one clause
(`includes the attachments A, B and C`).

Generated agent context remains searchable but does not expand into a document's
automatic trail. Its URLs and citations are derived references, not independent
sharing evidence. These documents receive a labelled context summary and do not
consume the deeper traversal allowance reserved for source results. The registry
of cognition-authored sources governs this distinction; ordinary messaging
conversations still contribute their observed sharing links.

Equal extracted text does not prove equal file bytes. A location or link does
not prove download direction or original sharing. Sender/author/recipient roles
are reported only when the graph records them. Fetch the decisive source body
when the question needs content beyond the supplied snippet and provenance.

## Budgets and completeness

All values below are optional. The limits apply per returned result. The first
`topN` eligible source results receive the deeper graph projection, and so does
any later result whose `refCount` reaches `minRefCount` (0 turns that off).

| Setting           | Default | Accepted range |
| ----------------- | ------- | -------------- |
| `topN`            | 3       | 1–10           |
| `minRefCount`     | 3       | 0–50           |
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
path, string and summary ceilings bound the emitted context. The summary character
budget covers prose facts, not the reference table; each document location and
URL has its own bounded field length.

`provenance.truncated` and `stopReasons` report hub, depth, node, copy and summary
limits. The result describes observed evidence within those budgets, not a
complete digital history. Hidden system sources and the current conversation
are omitted. Index/source revision disagreements do not produce copy claims.

## Follow-up graph tools

With v2 enabled, `fetch_many` neighbours (`includeNeighbors`) and
`trace_connections` follow the same structural links as search graph context —
attachments, calendar invitations, replies, thread membership, references and
links — and never reach hidden sources or Omnesis-generated documents, so a
follow-up walk never brings back what search left out. `trace_connections`
takes an optional `includeLinkTypes` to follow others (`near-duplicate`,
`duplicate-content`, `same-resource`, `succeeds`, `accompanies`, `bookmarks`,
`visited`, `shares-phone`). Its default depth is 2 when every seed is an
attachment or another part of a larger document, and 4 otherwise. A walk cut
short by its fanout or size limit carries a plain-words `note` alongside
`truncated`. The agent search port no longer attaches `breadcrumb` under v2.

## Compatibility and validation

`provenance` is an optional additive field on the existing document-reference
shape. Tool names, result kinds, representative IDs, snippets and existing URL
fields retain their contracts. Under v2, `trace_connections` gains the optional
`includeLinkTypes` argument and the optional `note` result field, and reference
rows gain optional `date` and `type`. Legacy clients can ignore the new
field; current clients can consume results without it. No new client handshake,
database migration or reindex is required. Disabling the flag restores the
existing projection. Use a fresh conversation for each A/B run: saved tool
evidence from a previous mode remains in that conversation’s history.

### Mixed-version boundaries

| Combination                                       | Behaviour                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New gateway, existing iOS/Android client          | Public search remains unchanged. Agent events keep the existing result kind, IDs, snippets and URLs; mobile decoders ignore optional provenance.                  |
| New gateway, existing Direct MCP client           | Canonical structured results keep existing fields. Optional provenance enriches unrestricted searches without adding tools, arguments or a handshake requirement. |
| Existing gateway, new OpenClaw/Hermes integration | Legacy search payloads are forwarded unchanged; no provenance field is required or synthesized.                                                                   |
| v2 explicitly disabled                            | New searches use the legacy projection, including separate candidate identities and legacy breadcrumbs. Graph tools follow every link type.                       |

The gateway advertises MCP protocol versions `2025-11-25` and `2026-07-28`.
Current OpenClaw/Hermes integrations already request `2026-07-28`; gateways that
only support an older, non-overlapping protocol are outside that existing
integration contract. This feature does not change delivery protocol versions;
the `trace_connections` manifest gains its optional `includeLinkTypes` argument
under v2. Custom clients that reject every unknown JSON field do
not satisfy the additive-field compatibility contract.

Native decoder regressions cover optional enriched fields and legacy public
search. HTTP regressions exercise enriched Direct results over both supported
MCP versions, and plugin regressions preserve legacy/enriched batch results and
error slots. Short labels belong only to a result's model presentation; fetch
and citation arguments still require the real document ID. Stored canonical
results remain available to clients and older model histories without readable
context keep their original serialization.

The `graph-search` synthetic universe supplies file copies, versions, a sharing
trail, a reference hub and unrelated activity by the same person. Replay
conversations execute live search and document tools rather than returning
recorded search payloads. The end-to-end suite verifies real ingestion, graph
resolution, context reduction, source restrictions and flag-off/public-search
compatibility, real CLI rendering, JSON output and disabled-route fallback. Unit tests exercise adversarial extraction, paths, budgets and
cross-version wire decoding.

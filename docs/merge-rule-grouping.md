# Merge-rule grouping & deterministic anchors

How the people graph represents a "merge a whole cluster of duplicates" action
on top of a strictly pairwise rule model, and how the star it builds picks a
stable, meaningful anchor.

Anchored in:

- `packages/gateway/src/merge-candidates.ts` — `mergeCluster`, `compareAnchorPriority`
- `packages/gateway/src/domain/merge/rule-crud.ts` — `deleteMergeRuleGroup`, `createMergeRule`
- `packages/gateway/src/domain/merge/rule-evaluator.ts` — union-find equivalence eval
- `packages/gateway/src/data/schema.ts` — `merge_rules.group_id` (added by migration 16)
- `packages/gateway/src/http/routes/people.ts` — `DELETE /people/merge-rules/group/:groupId`

## Edges are the primitive; clusters are derived

The people graph is a two-layer design. "Clusters" exist — but as derived state,
not a stored entity.

1. **Edges are the primitive.** `merge_rules` rows are pairwise and keyed on
   _aliases_ (`side_a_alias_type/alias ↔ side_b_alias_type/alias`), not person
   ids. Positive evidence ("these are the same") is a rule. Negative evidence
   ("these are NOT the same") is also pairwise but lives separately, as a durable
   `merge_candidates.status='denied'` veto.

2. **Clusters are derived.** `rule-evaluator.ts` runs union-find over the active
   rules, finds the connected components, picks a canonical root per component,
   and writes the result to `person_equivalences`, keeping `people.merged_into`
   in sync. A "cluster" is exactly the set of people sharing a root. The eval is
   the source of truth for `merged_into`; it re-derives on every relevant change
   and is idempotent (re-running over `person_equivalences` reproduces the same
   `merged_into` state).

So merging a cluster works end-to-end without a cluster entity:

```
mergeCluster([p1..p6])  →  5 user rules (a star)  →  eval union-find  →
component {p1..p6}  →  all six collapse to one canonical root.
```

## Why equivalence stays derived from edges

Equivalence is not stored as a `clusters` table; it is recomputed from the edge
graph. Three reasons:

1. **A stored table would duplicate derived state.** Equivalence is already
   materialized in `person_equivalences` / `merged_into`. A `clusters` table
   would be a second surface to keep in sync with the edges on every rule
   add/deny/auto-merge — an avoidable staleness class.

2. **Edges are strictly more expressive.** They compose three kinds of evidence
   in one graph: user rules (positive), denials (negative), and the
   auto-detector's exact-identifier pairs. A cluster entity cannot represent a
   denial — "A is _not_ B" is inherently an anti-edge — so the edge graph is
   needed regardless; a cluster model would sit on top of it, not replace it.

3. **Split / undo is naturally an edge operation.** Removing edges and
   re-deriving the component is the whole "split a person back out" story. A
   stored cluster would need bespoke split logic that has to agree with the edge
   graph.

## A cluster merge as one unit: `group_id`

A one-click cluster merge of six entities becomes five _disconnected_ rule rows.
The `group_id TEXT` column on `merge_rules` records that they were one decision:
every rule a single `mergeCluster` call creates is stamped with the same fresh
`group_id` (a UUID); rules created one pair at a time, or by the auto-detector,
leave it `NULL`. A partial index (`idx_merge_rules_group`, `WHERE group_id IS NOT
NULL`) makes batch lookup cheap.

This is purely a correlation tag — equivalence is still derived from the
individual edges, and `group_id` changes nothing about how `merged_into` is
computed. It enables:

- **Atomic undo.** `deleteMergeRuleGroup` deletes every rule `WHERE group_id = ?`
  in one statement, marks the merge-rules state dirty, and the eval re-derives
  `merged_into` on the next tick, splitting the component back into its members
  (modulo any other rules that independently relate some of them). This is
  exposed as `DELETE /people/merge-rules/group/:groupId` (admin scope) →
  `PersonService.deleteMergeRuleGroup` → writer op. The route is registered
  before `/people/merge-rules/:id` so the `:id` matcher does not swallow
  `/group/...`.
- **Audit.** One batch shares one `group_id`, timestamp, and `created_by`.
- **Portal grouping.** The merge-rules view groups accepted rules by `group_id`
  and offers "undo this merge" on the batch.

## The deterministic anchor

A star needs a center. `mergeCluster` picks the anchor with `compareAnchorPriority`,
the **same total order the eval uses to pick a component's surviving canonical**,
on its stable keys:

1. `is_self` wins (only one self exists; it always survives).
2. then highest recent interaction (`interaction_score_recent` — the contact the
   operator actually engages with).
3. then earliest `first_seen` (the longest-standing record).
4. then lexicographic id (a stable final tiebreak).

Every rule is written with the anchor on `side_a` and `winner_side: "a"`, so all
`winner_side` votes point at the anchor. This makes the star's center coincide
with the survivor, for two reasons:

- **The anchor _is_ the survivor.** The eval's canonical ordering is `is_self` →
  most `winner_side` votes → earliest `first_seen` → id. Because every rule votes
  for the anchor, the anchor collects all the votes and wins the eval's vote
  tiebreak; `is_self`, `first_seen`, and id align with the anchor ordering. So
  the person the rules point at is the person who actually survives, and the
  `winner_side` votes reinforce the outcome instead of contradicting it.

- **The choice is stable across re-runs.** Every key here is stable: `is_self`,
  interaction, and `first_seen` do not flip as a later sync adds aliases to a
  member. The same cluster merged twice picks the same anchor and emits the
  identical star, so the canonical-pair dedup in `createMergeRule` recognizes it
  and no redundant edges accrue. An anchor keyed on a mutable criterion such as
  alias count would drift — the alias-richest member today may not be tomorrow,
  producing a different star (`B↔A, B↔C` instead of `A↔B, A↔C`) for the identical
  intent — and would routinely disagree with the survivor the eval picks.

`compareAnchorPriority` is the single comparator both `mergeCluster` and the eval
follow on the stable keys, so the two cannot diverge.

### Worked examples

Fictional people; identifiers are illustrative.

**Example A — a self-merge.** The operator merges their own scattered identities:

| person    | aliases                                                  | is_self | first_seen |
| --------- | -------------------------------------------------------- | ------- | ---------- |
| `p_self`  | `me@example.com`, name "Maya Reeves"                     | ✅      | 2019-02-01 |
| `p_work`  | `maya.reeves@work.example`, `+1 555 010 0142`, lid, name | ❌      | 2021-06-10 |
| `p_stray` | `mr+news@example.org`                                    | ❌      | 2023-11-02 |

`is_self` wins the anchor ordering, so the anchor is `p_self`. Rules:
`p_self↔p_work`, `p_self↔p_stray`, both `winner_side: "a"` (→ `p_self`). The eval
collapses everyone onto `p_self` (self wins), and the join point the rules encode
is the survivor.

**Example B — no self, stable under a later sync.** Three duplicates of a contact,
merged once; a later sync adds two aliases to the newest duplicate:

| person  | first_seen | aliases (initially)       | aliases (after later sync)              |
| ------- | ---------- | ------------------------- | --------------------------------------- |
| `c_old` | 2018-03-04 | `theo@example.com`, name  | (unchanged)                             |
| `c_mid` | 2020-09-12 | `theo.brandt@example.org` | (unchanged)                             |
| `c_new` | 2024-01-20 | `tb@example.io`           | `tb@example.io`, `+1 555 010 0188`, lid |

With no self, the anchor is the earliest `first_seen` = `c_old`, in _both_ runs —
the added aliases on `c_new` do not move it. The same star (`c_old↔c_mid`,
`c_old↔c_new`) is emitted each time, dedup recognizes it, and no redundant edges
accrue. `c_old` is also what the eval picks as canonical (oldest, no self), so the
anchor is the survivor again.

**Example C — why a star, not a clique.** A clique (every pair gets an edge,
`N(N-1)/2`) is robust to a later single denial — deleting one edge cannot
fragment the component — but it is quadratic in storage and eval work, and it
muddies provenance (which of the 15 edges in a 6-clique is "the reason"?). The
star plus `group_id` gives the same atomic-undo benefit (drop the whole group) at
linear cost.

## What this is explicitly not

- **Not** a `clusters` / `person_clusters` table. Equivalence stays derived from
  edges and materialized in `person_equivalences` / `merged_into`.
- **Not** a change to how `merged_into` is computed. The eval is untouched; the
  anchor selection only affects which pairwise rules `mergeCluster` emits.
- **Not** a fix for partial-denial fragility. Denying one star spoke can drop a
  leaf out of the component even if it belongs; this is rare and re-merging is
  cheap, and `group_id` makes "re-link the surviving spokes" a trivial follow-up
  if it ever bites.

## Summary

Pairwise rules are the equivalence source of truth — they carry denials and
auto-detected pairs in one graph, and the cluster is already the derived
connected component. The `group_id` tag makes a one-click cluster merge one
auditable, undoable unit, and `compareAnchorPriority` anchors the star on the same
deterministic, meaningful ordering the eval uses to pick the survivor, so the
rule's join point is the person who actually survives and the choice does not
drift as sources sync.

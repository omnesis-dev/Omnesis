# GitHub issue labels

Omnesis keeps its issue labels deliberately minimal. There is **no `type:` / `area:` /
`topic:` taxonomy** and **no priority axis** — those axes were applied inconsistently,
went stale, and added more ceremony than signal. Don't reintroduce them. The label set is
a small group of GitHub-native states plus one workflow label.

## State labels (GitHub defaults)

The conventional triage set. Apply when they genuinely fit; most issues need none.

| Label              | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `duplicate`        | Closed in favour of another issue (the comment points to it). |
| `wontfix`          | Decided against; left closed.                                 |
| `invalid`          | Not actionable / not a real issue.                            |
| `question`         | Needs more information before it can be actioned.             |
| `good-first-issue` | Self-contained, good for a newcomer.                          |
| `help-wanted`      | Extra attention / contributors welcome.                       |

## Workflow labels

| Label                    | Meaning                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `architecture-violation` | Marks an issue reporting a breach of an architectural rule — usually the source-encapsulation contract (no source-specific logic outside `packages/providers/<name>/`). The daily source-encapsulation audit files one such issue per violation. |

## When you file a new issue

Write a clear title and body. Add a state label only if one obviously applies
(`good-first-issue`, `help-wanted`, …). Don't invent new label axes — if you think the
repo needs richer labelling, raise it first rather than minting labels ad hoc, and keep
this file and the GitHub label set in sync.

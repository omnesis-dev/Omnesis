# Search filters — demo queries

A walk-through of every filter the search grammar ships, with example queries to
paste into the portal search box or `omnesis search`. The examples use generic
placeholders (`Alice`, `Bob`, `alice@example.com`, `+15550100123`) — substitute
your own corpus values when running them. The portal's empty-state syntax help
renders the same examples with corpus-anchored values pulled live from `/people`
and `/status` (falling back to these placeholders on a cold or empty corpus).

Token grammar reminder:

- `key:value` — exact, or quoted for spaces (`key:"multi word"`).
- Filters of the same intent OR (`from:alice from:bob` → either).
- Filters of different intents AND (`from:alice to:bob` → both must hold).
- No `AND` / `OR` / `NOT` operators, no leading-hyphen negation. Quote a phrase to match literally.
- Tag matching is case-insensitive (`tag:inbox` matches `INBOX`). Person resolution is case-insensitive name LIKE / exact email / exact phone.

## Person filters — `from:` / `by:` / `to:` / `with:`

`from:` / `by:` match the sender/author/owner roles; `to:` matches the recipient
and attendee roles (mail addressed to the person, and events or meeting notes
that list them as an invitee); `with:` matches any role. How a person ref
resolves, in order (`resolvePersonIdsFromQuery` in `PersonRepository.ts`):

1. **Exact email** — the ref is normalized (`normalizeEmail`) and matched against the `email`-type aliases in `person_aliases`.
2. **Exact phone** — verbatim against `phone`-type aliases.
3. **Name LIKE** — `%query%` case-insensitive against `name`-type aliases (LIMIT 10 matches), each collapsed to its canonical person.

Returns the first non-empty match-set, expanded across merges so a canonical
also picks up documents attached to its merged-away sub-entities. A ref that
resolves to zero people always pushes a `person` notice, at the level its
consequence earns: `error` when nothing else in its OR bucket resolved either,
so the result set is empty rather than silently widening to a plain-text
search; `warning` when a sibling ref in the same bucket did resolve, so the
query still runs on that one. `from:me` / `to:me` resolve to the elected
self-person.

| What you want                                              | Query                             |
| ---------------------------------------------------------- | --------------------------------- |
| Everything from a known contact (substring match on name)  | `from:Alice`                      |
| Same contact but pin by email alias                        | `from:alice@example.com`          |
| Everything I sent                                          | `from:me hello`                   |
| Things sent to me by a known contact                       | `from:Alice to:me`                |
| Threads with a person under any role                       | `with:Alice`                      |
| Group threads that include a phone-only contact            | `with:"+15550100123"`             |
| Strict mixed-role intersection (Alice sent AND I received) | `from:Alice to:me dinner`         |
| Either Alice or Bob — same intent OR's                     | `from:Alice from:bob@example.com` |

## Document type — `type:` / `in:`

Bare-string match against `chunks.document_type`. Unknown values silently match
nothing. `in:` is an exact alias for `type:`.

| Type               | Example query                                    |
| ------------------ | ------------------------------------------------ |
| `email`            | `type:email Acme invoice`                        |
| `event`            | `type:event lunch`                               |
| `note`             | `type:note recipe`                               |
| `conversation`     | `type:conversation dinner` (WhatsApp + iMessage) |
| `file`             | `type:file budget` (Google Drive / OneDrive)     |
| `attachment`       | `type:attachment receipt`                        |
| `task`             | `type:task call` (Things)                        |
| `reminder`         | `type:reminder dentist`                          |
| `contact`          | `type:contact Alice`                             |
| `bookmark`         | `type:bookmark conference`                       |
| `webpage`          | `type:webpage climate` (browser extension)       |
| `browsing-history` | `type:browsing-history docs`                     |
| `activity`         | `type:activity London` (Strava)                  |
| `document`         | `type:document roadmap` (Notion)                 |
| `project`          | `type:project house` (Things)                    |
| Alias              | `in:event lunch` (same as `type:event`)          |

## Date — `after:` / `since:` / `before:` / `until:`

ISO `YYYY-MM-DD` only (no time, no timezone shift). Both bounds are inclusive of
the full day: `after:2026-05-19` includes everything from midnight onward,
`before:2026-05-19` includes everything up to end-of-day (`dateTo` is normalized
to `T23:59:59.999Z`). A same-day window `after:X before:X` returns all documents
created on that date. Relative keywords: `today`, `yesterday`, `"last week"` (7
days ago), `"last month"`, `"last year"` (the multi-word ones must be quoted).
Unparseable values get a `date` notice (`level: "error"`) and the filter is
dropped.

| What you want                        | Query                                                |
| ------------------------------------ | ---------------------------------------------------- |
| Anything in the last 7 days          | `since:"last week"`                                  |
| Calendar events this month           | `type:event since:"last month"`                      |
| Pre-2024 Outlook history             | `before:2024-01-01 source:outlook-email`             |
| Bounded window                       | `after:2026-01-01 before:2026-04-01 type:email Acme` |
| `until:` reads the same as `before:` | `until:2025-12-31 type:event`                        |
| Bogus date — observe the notice      | `after:tomorrow hello` (dropped; notice surfaced)    |

## Tag — `#tag` / `tag:`

Membership test against the `chunks.tags` JSON array (`json_each` +
`LOWER(...) = LOWER(?)`), case-insensitive on both sides. Multiple tag tokens OR.

| What you want                                        | Query                   |
| ---------------------------------------------------- | ----------------------- |
| Gmail INBOX (case-insensitive — matches `INBOX` too) | `#inbox` or `tag:INBOX` |
| Promotions slice (Gmail's `CATEGORY_PROMOTIONS`)     | `#CATEGORY_PROMOTIONS`  |
| User-defined triage tag                              | `tag:triaged`           |
| Multiple — either matches                            | `tag:finance tag:work`  |
| iMessage SMS bucket                                  | `tag:SMS`               |

## Source — `source:`

Four shapes, all resolved via `resolveSourcePatterns` (`@omnesis/core`) against
the distinct `(provider_id, source_id)` pairs present in the corpus
(`expandSourcePatterns` reads these from the `documents` table). Trailing-colon
and trailing-`*` forms are accepted as sugar for the bare form.

1. **Full source ID** — exact match. `source:gmail:alice@example.com`.
2. **Bare source type** — every account under that type. `source:gmail` → every `gmail:*`.
3. **Provider ID** — every source under that provider account. `source:google:alice@example.com` → gmail + calendar + drive + contacts.
4. **Bare provider type** — every source under that provider, across all accounts. `source:google`, `source:apple`.

Unresolved values push a `source` notice (`level: "error"`); successful prefix
expansions push a `level: "info"` notice so the caller can see what got resolved.

| What you want                             | Query                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| One Gmail account                         | `source:gmail:alice@example.com Acme`                          |
| Any Gmail account                         | `source:gmail Acme` (bare type)                                |
| Every Google source under one account     | `source:google:alice@example.com receipt` (provider ID)        |
| Every Google source under any account     | `source:google receipt` (provider type — expands to 4 sources) |
| Every Apple source                        | `source:apple meeting`                                         |
| Mix two source filters (OR within intent) | `source:gmail source:outlook-email invoice`                    |
| Bogus — observe the notice                | `source:nope hello`                                            |

## Putting it all together

Real multi-filter queries that stitch several intents:

```
from:me to:Alice since:"last month" dinner             # what I sent Alice recently
type:email source:gmail since:"last week" cleaning     # last week's cleaning emails
type:event with:Alice since:"last year"                # any event involving Alice this past year
source:google-drive type:file budget                   # Drive files mentioning "budget"
type:conversation source:whatsapp-messages dinner      # WhatsApp threads about dinner
#INBOX from:Acme                                        # Acme emails still in the inbox
```

## Notices and verbose output

The `/search` response always carries a `notices` array whenever a filter
produced feedback — a dropped date, an unresolved or expanded source, or an
unresolved person. It is not gated on verbose; any client can read it to explain
why a result set is empty or narrowed. Notices fall into six
(filter, level) categories:

| Filter   | Level     | Triggers when                                                                                          |
| -------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `date`   | `error`   | Value couldn't be parsed as ISO or a relative keyword — filter dropped                                 |
| `source` | `error`   | Value matches no configured source — filter resolves to zero docs                                      |
| `source` | `info`    | Bare prefix expanded to a list of source IDs (shows the expansion)                                     |
| `person` | `error`   | Person ref didn't resolve, and no other ref in its OR bucket did either (or `me` with no elected self) |
| `person` | `warning` | Person ref didn't resolve, but a repeated ref in the same bucket did — the query still runs            |
| `person` | `info`    | Person resolved but has no documents in the requested role — filter resolves to zero docs              |

Example response shape:

```json
{
  "notices": [
    {
      "filter": "source",
      "level": "info",
      "token": "source:google",
      "message": "Expanded \"google\" to 4 sources: gmail:..., google-calendar:..., google-contacts:..., google-drive:..."
    },
    {
      "filter": "person",
      "level": "error",
      "token": "from:typo",
      "message": "No person in the people graph matches \"typo\" (tried email, phone, name LIKE). Filter resolves to zero docs."
    }
  ]
}
```

Setting `verbose: true` on the request body additionally includes a `debug`
block (model readiness) alongside the per-stage timing the response already
carries. The portal's verbose checkbox sets `verbose: true`;
the CLI's `--verbose` flag formats extra local timing/query output from
always-present response fields and does not itself request the `debug` block.

## Not part of the grammar

The parser recognizes exactly the keys above (`from`, `by`, `to`, `with`,
`type`, `in`, `after`, `since`, `before`, `until`, `tag`, `source`) plus
`#tag`. A token using any other form is not treated as a filter: it falls
through to the plain-text query, and a leading `-` is kept as a literal
character (quote a phrase to match a `-` literally). In particular the grammar
has no:

- **Negation** — `-from:noreply@example.com`, `-type:webpage`.
- **Boolean operators** — `AND` / `OR` / `NOT` / `NEAR`. Multi-token text is conjunctive by ranking only.
- **Content predicates** — `has:attachment`, `has:link`, `has:image`. Only the implicit text trick (`attachment` as a plain word) matches.
- **State predicates** — `is:unread`, `is:flagged`, `is:reply`, `is:thread`, `is:meeting`.
- **Fine person roles** — `cc:`, `bcc:`, `mentions:`, `attendee:`, `replies-to:`.
- **Sort / comparison** — `sort:newest`, `refcount:>3`, `score:>0.7`.
- **Date sugar** — `date:2025`, `date:Q1-2025`, `weekday:saturday`.
- **Wildcards** — `from:linked*`, `tag:project-*` (source patterns are the one exception — see above).

# Released database fixture

`gateway.db.gz` was created by the **v0.6.0 release**, whose live schema is 188. It is not a current database with columns removed or its version rewound.
The manifest pins the release commit and archive digest, counts the rows of
every non-empty table, and keeps every row of each table the seed wrote, in the
release's own columns.

All data is fictional, written through the release's own functions: documents
and cursor preservation sentinels for a few sources, a person with vouched
aliases and a manual merge rule, quick-capture notes (typed, located, a voice
note awaiting its transcript and one the transcript replaced), harness-pushed
agent messages with an unread conversation, open loops with a ledger entry,
document and person memory with evidence, cognition notes, a brief, a sweep
tally and queued runs, and an access level with an external agent connected on
it. Cursor sentinels prove storage preservation, not provider resumption.

`schema-shape.json` is the release's fresh schema: each table's columns, and
whether the release's schema setup creates the table again when it is missing.
It backs the rollback check in `release-upgrade-188.test.ts`.

To regenerate, prepare a separate checkout at the manifest's revision with its
dependencies installed, then run from the current checkout:

```sh
npm run fixtures:release-upgrade -- /path/to/release-checkout
```

The generator opens only fresh temporary databases. It does not use an
installed configuration, credentials or personal corpus. Regeneration changes
generated IDs, token hashes and clock-stamped timestamps; commit the archive,
manifest and shape together.

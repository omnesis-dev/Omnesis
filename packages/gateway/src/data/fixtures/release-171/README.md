# Released database fixture

`gateway.db.gz` was created by the **v0.4.22 release**, whose live schema is 171. It is not a current database with columns removed or its version rewound.
The manifest pins the release commit and archive digest and records the rows
whose identity/content must survive an upgrade.

All data is fictional. Every source type loaded by that release's registry has
an installed source, document and cursor preservation sentinel. Sentinels are
deliberately **not provider cursor fixtures**: this test proves database
migration and replay preservation, not upstream sync conformance. It also holds
alias provenance, a namespaced-ID migration case, a manual merge rule and
equivalence, and the access-level tables shipped at schema 171.

To regenerate, prepare a separate checkout at the manifest's revision with its
dependencies installed, then run from the current checkout:

```sh
npm run fixtures:release-upgrade -- /path/to/release-checkout
```

The generator opens only a fresh temporary database. It does not use an
installed configuration, credentials or personal corpus. Regeneration changes
generated document/device IDs and timestamps; commit the archive and manifest
together.

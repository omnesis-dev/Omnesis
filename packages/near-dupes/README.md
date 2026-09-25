# @omnesis/near-dupes — study tool

Side study: MinHash + LSH near-duplicate detection over the Omnesis corpus.
Reads `omnesis.db` read-only; writes its own DB at
`~/.config/omnesis/omnesis-dupes/dupes.db`. Does not touch any production
Omnesis state.

The pure algorithm under `src/algo/` is designed to be lifted into the
gateway later for the production graph-edge implementation.

## CLI

```bash
tsx packages/near-dupes/src/runner/cli.ts run        # bootstrap signatures + pairs
tsx packages/near-dupes/src/report/cli.ts stats      # signature/pair counts
tsx packages/near-dupes/src/report/cli.ts clusters   # connected components
tsx packages/near-dupes/src/report/cli.ts show <doc> # near-dupes of a document
tsx packages/near-dupes/src/report/cli.ts sample     # random pairs in a jaccard band
```

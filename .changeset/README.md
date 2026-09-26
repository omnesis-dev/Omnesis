# Changesets

Version management for the `omnesis` + `@omnesis/*` graph. All packages
version in lockstep (the `fixed` group in `config.json`) — one product version
across gateway, collector, CLI, providers, and runner.

Flow for a release:

1. `npx changeset` — describe the change, pick a bump level.
2. `npx changeset version` — bumps every package + writes CHANGELOGs.
3. `npm install` — refresh the lockfile.
4. Align iOS and Android marketing versions, then run
   `npm run release:check-version -- v<version>`.
5. `npm run build && npm run typecheck && npm test`
6. Land on `main`, wait for CI, then run
   `npm run release:preflight-tag -- v<version>` (it also refuses while the
   install/update lanes on `main` are red; see `docs/install-e2e.md`).
7. Create an annotated tag on the SHA printed by the preflight:
   `git tag -a v<version> -m "Omnesis <version>" <main-sha>`.
8. Push only that tag: `git push origin v<version>`.

The active release is source-only. Tagging does not publish npm packages or
container images; those pipelines are retained for future distribution and
local validation.

Workspace dependencies stay `"*"` in the repo (so dev tooling resolves
TypeScript source directly); `@omnesis/*` dependencies are pinned to the
lockstep version at publish time by `scripts/release/transform-manifest.mjs`.
See `docs/releasing.md` for the full story.

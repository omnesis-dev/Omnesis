# Contributing to Omnesis

Thank you for your interest in Omnesis. Omnesis is a local-first personal
search engine — it indexes your digital life on your own machine and exposes
it through a private gateway. The project's animating constraint is that
**nothing leaves your machine**; every contribution is measured against
that bar.

This guide covers what you need to know to land a change. For deeper context
on architecture, sources, search internals, and the source roadmap, see the
public docs at [omnesis.dev/docs](https://omnesis.dev/docs) (source pages
under [`website/docs/`](website/docs/)).

---

## Prerequisites

| Tool                        | Why                                 | Notes                                           |
| --------------------------- | ----------------------------------- | ----------------------------------------------- |
| **Node ≥ 24**               | runtime for gateway, collector, CLI | macOS users on Homebrew: `brew install node@24` |
| **Xcode 16+**               | iOS app and SwiftLint/SwiftFormat   | macOS only; required only if you touch `ios/`   |
| **XcodeGen**                | regenerates `ios/Omnesis.xcodeproj` | `brew install xcodegen`                         |
| **SwiftFormat + SwiftLint** | iOS code style / lint               | `brew install swiftformat swiftlint`            |

The TypeScript codebase is the primary surface and is the only one you need
to set up to contribute to gateway / collector / providers / CLI.

---

## Quick start

```bash
git clone https://github.com/omnesis-dev/Omnesis.git
cd Omnesis
npm install            # installs deps + sets up lefthook git hooks
npm run typecheck      # tsc --build across the monorepo
npm test               # vitest, ~3700 tests
```

If `npm install` hits the dedup quirk around `@clack/prompts`, run it again —
it almost always resolves on the second attempt.

---

## Repository layout

```
packages/types/         branded IDs, narrow shared types
packages/config/        omnesisConfigSchema (zod) — all tunables
packages/source-sdk/    defineSource() helpers for new sources
packages/core/          domain types, logger, link extraction
packages/gateway/       HTTP + SQLite + indexer
packages/collector/     sync engine + source manager
packages/cli/           the `omnesis` CLI
packages/cli-shared/    CLI-only helpers
packages/providers/*    one package per data source (gmail, notion, ...)
ios/                    native iPhone companion app (SwiftUI)
website/                omnesis.dev site — landing page + public docs (website/docs/)
scripts/                bench / admin / chaos scripts
```

The high-level architecture is covered in the public docs at
[omnesis.dev/docs](https://omnesis.dev/docs);
the engineering conventions are codified in
[`docs/conventions.md`](docs/conventions.md) — read that before establishing
or imitating any cross-cutting pattern.

---

## Development workflow

### Run the gateway and collector locally

```bash
npm run gateway        # in one terminal — HTTP on :7600
npm run collector      # in another terminal — sync engine
npm run status         # uses the CLI to inspect what's running
```

Configuration directory defaults to `~/.config/omnesis/`. Override with
`OMNESIS_CONFIG_DIR=/path/to/dir` if you want isolation from a live setup.

### Tests are mandatory

Every bug fix and feature lands with tests. New sources need at least
sync (bootstrap + incremental), normalization, and error-handling tests.
Tests live next to the source file as `*.test.ts`.

```bash
npm run checks:plan -- --base origin/main      # inspect selected work
npm run checks:affected -- --base origin/main  # authoritative branch gate
npm run checks:full                            # explicit full validation
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

Use unique temp paths for gateway DB tests (`/tmp/omnesis-test-{uuid}.db`)
and ports `17601+` for integration tests so they don't collide with a
running local instance.

### Lint and format

```bash
npm run lint           # ESLint (errors fail; warnings are visible)
npm run lint:fix       # auto-fix what's auto-fixable
npm run format         # Prettier write
npm run format:check   # Prettier check (used in CI)
npm run privacy:scan   # full-tree PII / secret guard
```

For Swift code in `ios/`:

```bash
swiftformat ios        # auto-format
swiftlint              # lint (uses .swiftlint.yml)
```

Pre-commit hooks (via [lefthook](https://lefthook.dev)) run ESLint /
Prettier on staged TypeScript and SwiftLint / SwiftFormat on staged Swift.
Pre-commit also scans staged additions for PII and secrets; pre-push runs
the full-tree privacy and format checks. Run the whole-program typecheck, lint,
and tests as explicit final validation; CI also runs dead-code analysis. **Do not bypass hooks
with `--no-verify`** — if a hook is misfiring, fix the root cause and open
an issue.

### Fixture privacy

Never copy names, emails, phone numbers, vendors, addresses, hostnames, or
stories from a live Omnesis corpus into tests, docs, previews, comments, or
fixtures. Invent them from scratch.

The privacy guard blocks new real-looking emails, phone numbers, private
network identifiers, common secret shapes, and full-name candidates in
high-risk fixture/test paths unless they are already reviewed in
[`privacy/pii-allowlist.json`](privacy/pii-allowlist.json). That allowlist is
for fictional or deliberately public fixture values only. If you need a new
fake identity, add it there in the same PR so reviewers can inspect it.

For contributor-specific identifiers that must never be committed, create an
untracked `scripts/pii-denylist.txt` and put one literal per line. Matches are
reported without echoing the literal.

### TypeScript code style

A summary of the codified rules (full list in
[`docs/conventions.md`](docs/conventions.md)):

- TypeScript strict mode. No `any` outside test files.
- ESM imports use the `.js` extension even on `.ts` sources.
- Cross-package imports use the workspace name (`@omnesis/core`,
  `@omnesis/gateway`, …) — never a relative path into another package.
- Use the structured logger (`createLogger` from `@omnesis/core`).
  `console.*` is forbidden outside the logger module, CLIs, and scripts.
- Logger style: concise one-liners with template literals, not
  structured-data objects. Good: `log.info(\`Sync complete for ${id}\`)`.

ESLint encodes most of these — if you see a complaint, the message points
at the underlying convention.

### Swift code style

SwiftFormat and SwiftLint own formatting and lint. Every view in
`ios/Sources/Omnesis/UI/` ships with at least one `#Preview` block; add
or update one in the same commit when you add or materially change a view.

---

## Pull request process

1. **Open an issue first** for anything larger than a small fix or doc
   tweak. For a new data source, open a deep-dive issue describing the
   source and link it to the data-sources roadmap.

2. **Branch off `main`**, push, open a PR.

3. **Update docs in the same PR.** If you change user-visible behaviour —
   defaults, types, HTTP endpoints, CLI commands, source semantics — find
   the affected page under `website/docs/` (published at
   https://omnesis.dev/docs) and update it.

4. **PR checklist** (the template will prompt you):
   - [ ] Tests added or updated
   - [ ] `npm run checks:plan -- --base origin/main` selects the expected work
   - [ ] `npm run checks:affected -- --base origin/main` passes
   - [ ] Docs updated for any user-visible change
   - [ ] If touching `ios/`, ran `xcodegen generate` after editing
         `project.yml` or adding a new `*.swift` file
   - [ ] If adding or changing a data source, ran `/source-review` and
         completed its manual validation list

5. **Run the focused checks locally, then let CI run the rest.** Every pull
   request into `main` runs the validation lanes its change affects, and every
   push to `main` runs the full suite (`.github/workflows/full-validation.yml`)
   on GitHub-hosted runners: Linux, macOS, browser, iOS and Android, install,
   Docker, harness and security lanes.
   A pull request from a fork runs once a maintainer approves it. A newer push
   to the same pull request cancels the older run. A failure on `main` is fixed
   forward, and a change that reddens it may be reverted.

---

## Adding a new data source

Sources are how Omnesis ingests data. Every source authenticates **once**
and then syncs in the background — sources whose only ingestion path is
a manual export (Google Takeout, Facebook DYI, …) are out of scope.

Walk through:
[omnesis.dev/docs/building-sources](https://omnesis.dev/docs/building-sources)
(source page: [`website/docs/building-sources.html`](website/docs/building-sources.html)).

Then propose it by opening an issue describing the source and linking it to
the data-sources roadmap.

Before opening the PR, run `/source-review packages/providers/<name>` in
Claude Code (the command lives at
[`.claude/commands/source-review.md`](.claude/commands/source-review.md)).
It audits the source against the full contract — viability and platform
terms, encapsulation, auth, the sync runtime, deletions, people, URLs, icons,
the Watch ontology, multiple accounts, the multi-device mode, every
registration point outside the package, and tests — fixes mechanical
omissions, and ends with the checks only a person can do. Without Claude
Code, the file reads as the checklist; walk it by hand.

---

## Security

Found a vulnerability? Please follow the disclosure process in
[`SECURITY.md`](SECURITY.md) — do **not** open a public issue.

---

## License and Contributor License Agreement

Omnesis is licensed under the **GNU Affero General Public License v3.0 or later**
(AGPL-3.0-or-later); see [`LICENSE`](LICENSE). Every source file carries an SPDX
header (`// SPDX-License-Identifier: AGPL-3.0-or-later`); the pre-commit hook adds
it automatically to new files, so you don't need to add it by hand.

Contributions are also covered by a **Contributor License Agreement**
([`CLA.md`](CLA.md)). Be aware of what it says: it is a copyright **assignment**
to the project owner, plus a grant of the right to **relicense** your contribution
under other terms — including proprietary or commercial licenses. This keeps
future relicensing options open for the project (for example, offering a
commercial license alongside the AGPL). The CLA-Assistant bot runs on your first
pull request and asks you to sign by leaving a comment; it records your signature
in [`signatures/cla.json`](signatures). A PR cannot be merged until the CLA is
signed. If the assignment model is a blocker for you, open an issue — we'd rather
find a path than lose the contribution.

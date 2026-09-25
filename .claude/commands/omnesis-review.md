Audit all code changed in this session — both committed and unstaged. Spawn
multiple sub-agents in parallel, each responsible for a subset of the checks
below. Only apply checks that are relevant to the changes in scope.

Before dispatching sub-agents, run `git diff HEAD~N` (where N covers today's
commits) and `git diff` (unstaged) to determine the full scope. Pass each
sub-agent the exact list of changed files and their role.

---

## Checks

### Design and architecture

- **Elegance.** Are the abstractions well-considered, or does the code feel
  like duct tape? Would a staff engineer approve this design?

- **Source encapsulation.** No source-specific logic (branching on a source
  name, unit nouns, icons, URL handling, display strings) outside that
  source's provider package. The `defineSource()` descriptor is the contract —
  extend it rather than hardcoding downstream. Generic abstractions (registry
  iteration, `:sourceType` routing) are fine.

- **Routes only call services.** HTTP route handlers are thin adapters: parse,
  call a domain service, map the result. No direct imports of repositories,
  the writer queue, or the scheduler in route files.

- **assertNever exhaustiveness.** Every switch on an internal discriminated
  union ends with `default: assertNever(x)`. External-data switches use typed
  defaults instead.

- **Facade pattern.** If a module grew past ~600 LOC or gained unrelated
  responsibilities, was it split into focused collaborators behind a thin
  facade? Check against `docs/conventions.md` for the canonical examples.

### Correctness

- **Edge cases.** Does the code handle all realistic edge cases? If covering
  an edge case would add disproportionate complexity, flag it for discussion
  rather than silently fixing.

- **Concurrency.** Check for race conditions, ABA problems, TOCTOU bugs, and
  stale-read hazards — not just in background jobs but anywhere concurrent
  access is possible (writer queue, sync engine, scheduler).

- **Background jobs.** If new or modified: (a) is the algorithm correct under
  concurrent execution? (b) could it starve lower-latency work like agent or
  user requests? Watch for writer-queue contention.

- **What does this cost the writer?** Ask it of every change that touches a
  writer path. Does it do a lookup inside a writer transaction — resolution,
  a membership test, anything that reads — where the read could happen on the
  io handle and be passed in? Does it iterate without committing in
  sub-batches and checking the preempt token between them, so one oversized
  input holds the write lock for as long as that input is large? See
  `docs/conventions.md` § "The writer is one thread".

- **Does this change what a consumer assumed?** A producer — a new source, a
  normalizer emitting more links or people per item, a route ingesting a new
  shape — can be correct in itself and still break a consumer whose cost model
  assumed the old volume. If the change alters how much of anything is
  produced per item, name the consumers of that data and say what the new
  volume costs them. The defects this question exists to catch were all of
  this form: each piece locally reasonable, nobody owning the interaction.

### Security and privacy

- **Security.** No command injection, XSS, SQL injection, path traversal, or
  other OWASP top 10 vulnerabilities. Validate at system boundaries (user
  input, external APIs, HTTP bodies).

- **Privacy (corpus data).** No real _indexed_ user data — names, emails, phone
  numbers, addresses, vendors, personal context from the user's corpus — in
  fixtures, test inputs, examples, comments, commit messages, or anywhere else
  in the codebase. Invent all example data from scratch per the rules in
  CLAUDE.md. (Operator/machine setup leakage is covered under _Open-source
  hygiene_ below.)

### Open-source hygiene

This is a public repository. Beyond "is this good code," every change must be
safe to be public.

- **Operator & infra leakage.** No operator- or machine-specific detail in
  committed (non-gitignored) files: machine names, tailnet/LAN IPs, hostnames,
  live-service control (tmux panes, ports as infrastructure), local model
  endpoints, or internal tooling names. These belong only in `CLAUDE.local.md`
  (gitignored) — never in `AGENTS.md`, source, or public docs. The
  `scripts/pii-scan.mjs` guard enforces the specific identifiers; confirm it
  passes.

- **Non-public references.** No links or references to issue trackers, repos,
  dashboards, or resources a public contributor cannot access — inline the
  rationale instead. Never use a bare `#NNN` to reference a non-public issue; it
  collides with this repository's own public issue numbers.

- **CI supply-chain & fork safety.** Any new or changed `.github/workflows/` job
  that triggers on `pull_request` and runs on a self-hosted runner MUST be
  fork-guarded (`if: github.event.pull_request.head.repo.full_name ==
github.repository`) — otherwise a fork PR can run arbitrary code on the
  maintainer's machines. Pin new third-party actions to a full commit SHA. Never
  expose secrets to `pull_request` / `pull_request_target` from forks.

- **License & third-party attribution.** New source files carry the SPDX header.
  Vendored or third-party code must NOT be stamped with the project's
  AGPL/copyright header, must keep its upstream license notice, and must be
  listed in `THIRD_PARTY_NOTICES.md`. New bundled brand assets (icons, fonts,
  logos) need a `TRADEMARKS.md` entry and correct attribution.

### Code hygiene

- **Dead code.** Did the changes leave behind unused imports, functions,
  types, variables, or files? Delete them.

- **TypeScript strictness.** No `any` except in test mocks. No
  `console.log/warn/error` — use the structured logger (`createLogger`).
  Imports use `.js` extensions. No cross-package relative imports (use
  `@omnesis/core`, `@omnesis/types`, etc.).

- **Logger conventions.** Logger components follow the hierarchy
  (`gateway`, `gateway:http`, `provider:google`, etc.). Messages are concise
  one-liner template literals, not structured-data objects.

- **Zod at boundaries.** HTTP route bodies are validated via per-route zod
  schemas. Branded ID constructors (`SourceId()`, `ProviderId()`, etc.)
  validate input — no `as SourceId` casts on untrusted data.

- **Configurable tunables.** Did the changes introduce magic numbers or
  hardcoded thresholds that should live in `omnesisConfigSchema`
  (`packages/config/src/config-schema.ts`)? If a value is likely to be tuned
  by future agents or the user, expose it through the config schema. Flag
  uncertain cases for discussion.

- **Comment quality.** Comments describe the code as it exists now, for a
  reader with no prior context. No references to prior versions, refactors,
  recent changes, or session-specific context. No "we changed X from A to B"
  — just explain B. Test: would a stranger opening the file a year from now
  understand this comment without access to the conversation or git history?

### Testing

- **Coverage.** Every new feature and bug fix includes tests. New sources
  need sync (bootstrap + incremental), normalization, and error-handling
  tests. Tests use vitest, placed next to source files as `*.test.ts`.

- **Test quality.** Tests exercise meaningful behavior, not implementation
  details. No tests that assert junk or merely prove the mock works. Edge
  cases and error paths are covered, not just the happy path.

### Documentation

- **Public docs.** If user-visible behavior changed (defaults, types, HTTP
  endpoints, CLI commands, source semantics, error states, new or removed
  features), check `website/docs/` for affected pages and update
  them. Use the anchoring table in CLAUDE.md to find the right page. Don't
  add docs for every internal detail — maintain a consistent level of detail.

- **CLAUDE.md / README accuracy.** Did the changes make any rules or
  descriptions in CLAUDE.md or README.md stale? If so, update them.

- **GitHub issues in code.** If GitHub issues were created this session, are
  they referenced at the relevant call sites with a short comment
  (`// See #NNN — ...`)? This helps future agents discover tracked work
  without searching GitHub. Skip this for large-feature tracking issues.

### Agent protocol (only if changed)

- **Synthetic conversations.** If tool specs, transcript storage, or tool
  inventory changed: are the synthetic conversations in the active universe
  updated to reflect the new protocol? New tools need a scenario exercising
  them; removed or modified tools need existing scenarios updated. Synthetic
  conversations must be grounded in real documents from the synthetic corpus.

### iOS (only if views changed)

- **SwiftUI previews.** Are there enough previews for added or modified
  views? Do the previews cover all meaningful state combinations (empty,
  loading, error, populated, edge cases)? This is the agent feedback loop —
  without it, layout verification requires human testing.

---

## Execution rules

- Determine the right sub-agent split based on the scope of changes. Each
  sub-agent gets a clear role and the list of files to review.

- Once sub-agents report back, fix all issues directly — don't just list
  them. Pause and ask for the user's opinion only when a fix involves a
  judgment call (e.g. disproportionate complexity for an edge case, whether
  a tunable belongs in config).

- Fix forward on the current branch unless otherwise specified.

- Ensure tests pass after all fixes. Add tests for the fixes themselves when
  applicable.

- Run `npm run typecheck` after all changes to catch any type errors
  introduced by the fixes.

$ARGUMENTS

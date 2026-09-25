# Agent environment gotchas — cheat-sheet

A consolidated list of the environment footguns that bite autonomous agents
working in this repo. Each entry names the **trap** (the thing that looks like it
worked but didn't, or that fails in a confusing way) and the **fix**. When a new
recurring footgun shows up, add it here rather than re-discovering it.

These are environment/tooling traps. Code conventions live in
`docs/conventions.md`; per-surface rules live in `AGENTS.md`, `ios/AGENTS.md`,
and `android/AGENTS.md`.

## Sandbox-blocked foreground `sleep`

**Trap.** A foreground `sleep N` (or any command that blocks the foreground for a
fixed wall-clock interval) is blocked by the sandbox the agent runs commands
under. Tests and scripts that "wait a bit" with a bare foreground `sleep` hang or
are killed, and a test that spawns a worker with `sleep` as its body to keep it
alive will not behave the way it does in a normal shell.

**Fix.** Never block the foreground on a fixed sleep. To wait for a condition,
poll it (re-run a cheap check in a bounded loop until it's true or a deadline
passes). To keep a throwaway process alive long enough to act on it, spawn it
**detached / in the background** (e.g. `sleep 30 &`, or `setsid`/`nohup` for a
longer-lived one) and capture its PID, then act on the PID — don't foreground the
sleeper. Always bound the wait and clean up the spawned process in a `finally`.

## `pkill -f` self-match

**Trap.** `pkill -f <pattern>` matches against the **full command line of every
process, including pkill's own** and the shell/script that launched it. A pattern
broad enough to catch your target (e.g. the script name, or a substring that
appears in your own argv) will also match — and kill — the very process doing the
killing, or its parent shell. The kill "succeeds" but takes you down with it, or
silently no-ops because the only match was yourself.

**Fix.** Use `scripts/lib/safe_kill` (see below): it drops `$$` (the current
shell) and `$PPID` (its parent) from the match set, and **loud-fails** when the
pattern matches nothing or only the caller — so a wrong/too-broad pattern surfaces
as a named error instead of either a no-op or self-destruction. If you must use
`pkill`/`kill` directly, narrow the pattern, exclude your own PID, and verify the
match set before killing.

## zsh `noclobber` — `>` fails if the file exists

**Trap.** The interactive shell here runs with zsh's `noclobber` (a.k.a.
`no_clobber`) option set: the `>` redirection **refuses to overwrite an existing
file** and errors with `zsh: file exists`. A script step that does
`something > out.log` works the first time and then fails on every rerun, which
reads as a spurious failure unrelated to what you changed.

**Fix.** Either truncate-overwrite explicitly with `>!` (`something >! out.log`),
or `rm -f out.log` before the redirect. Appends (`>>`) are unaffected. Prefer
`>!`/`rm -f` over assuming a clean working dir.

## Playwright `networkidle` never fires on SSE pages

**Trap.** `waitForLoadState("networkidle")` (and `waitUntil: "networkidle"`)
waits for the network to go quiet for 500ms. The portal holds **long-lived
connections** — long-lived SSE streams (the agent stream plus live config, auth-flow, and
import-history updates) — so the network is _never_ idle. A wait on `networkidle` hangs until the
timeout, then fails, even though the page rendered fine.

**Fix.** Wait on a **selector** that proves the thing you care about is present
(`page.waitForSelector("…")`), or on a readiness endpoint (`GET /health`) for
gateway boot — never on `networkidle`. The committed `playwright.config.ts`
follows this: its `webServer.url` is `${baseURL}/health`, not a page load. Mirror
that in any new portal e2e or screenshot script.

## Worktree symlink-farm — workspace package resolution

**Trap.** In a secondary git worktree, a naive `ln -s primary/node_modules
node_modules` is **subtly broken**. Inside the hoisted npm workspace,
`node_modules/@omnesis/<pkg>` are themselves symlinks like `../../packages/<pkg>`.
Resolved through the primary's `node_modules`, they land in the **primary's**
`packages/<pkg>` — so your worktree's edits to a shared workspace package are
invisible to other packages in that same worktree. The symptom is confusing:
"no exported member" typecheck errors against code you just added, or tests that
pass green against stale source.

**Fix.** Run `scripts/setup-worktree.sh` from inside the worktree. It builds a
symlink **farm**, not a single symlink: every third-party top-level entry is
shared from the primary (so nothing re-downloads), while `@omnesis`, the
unscoped `omnesis` entry package, and its `.bin/omnesis` executable resolve into
**this** worktree's `packages/*`. Re-run the script if the primary runs `npm
install` mid-session (the shared third-party links can shift underneath you).

## `actions/setup-node`'s `cache: npm` and the persistent-runner trap

The validation workflows run on ephemeral GitHub-hosted runners and declare
`cache: npm`: each job starts on a clean machine, and restoring `~/.npm` keyed
by the lockfile is what keeps `npm ci` quick there.

On a long-lived (self-hosted) runner the same line does harm. `~/.npm` already
persists between jobs, so the action only ships an ever-growing copy back and
forth: one such cache reached 8.1 GB, its restore died when the download's own
token expired ten minutes in, and the step spent another ten minutes giving up
— twenty minutes of a twenty-five-minute job, which looked for all the world
like a test timeout.

Two jobs deliberately stay uncached: the harness-conformance lane, whose pinned
third-party installs start clean, and the release workflow, which builds what it
publishes from nothing restored.

## Pinned harness conformance

The OpenClaw and Hermes managed integrations cross APIs owned by other
projects. Typechecking the OpenClaw SDK and testing a hand-written Hermes host
do not prove that either real loader still accepts the packaged plugin.
`.github/workflows/harness-conformance.yml` therefore runs two independent
nightly lanes: each installs one deliberately pinned harness, completes the
real `omnesis connect` ceremony against an isolated Gateway with subscription
capability enabled, and starts the real host long enough to prove the exact
full three-tool registration contract.

Advance a harness pin deliberately. Run both lanes manually before merging a
pin change. Keep Hermes's full commit immutable in the workflow and
OpenClaw's exact dependency immutable in `package.json` and the package lock.
These tests never issue a prompt or invoke a tool. They boot with no model
credential; the OpenClaw lane disables its startup update check, while Hermes
disables startup model warmup, optional downloads, and lazy installs. Adding
an agent turn here is forbidden even if pointed at a cheap or local chat
model—the repository-wide test policy substitutes chat models at a production
seam instead.

## Scoped tests and shared-machine checks

**Trap.** Vitest's positional filters match substrings anywhere in a file path.
`npx vitest run extension` also selects `browser-extension.e2e.test.ts`, and a
package filter can start gateways when only unit tests were intended.

**Fix.** Use `npm run test:unit:vitest -- extension/` or
`npm run test:unit:vitest -- packages/<pkg>/` for unit checks. That command
excludes E2E and the separately scheduled developer-script smoke suite. Use
`npm run test:unit:smoke` for the latter, and
`npm run test:e2e -- <path/to/file.e2e.test.ts>` for a selected E2E suite.
The aggregate `test:unit` command prepares compiled workspace artifacts for the
release-staging tests; focused units avoid that full prerequisite.
Use `npm run checks:plan -- --base origin/main` to inspect the Nx selection and
`npm run checks:affected -- --base origin/main` for the final implementation and
review pass. The plan includes committed branch changes plus staged, unstaged,
untracked, deleted and renamed paths. If the checkout changes while a queued
task waits, the task rejects the stale fingerprint and must be replanned.

Nx owns dependency discovery, affected calculation, task ordering and local
caching. The installed shared-host and native dispatchers still own physical resource
admission. A cache hit therefore takes no heavy reservation; a cache miss enters
the matching lane. Use `npm run checks:bundle -- <bundle>` for extra diagnostic
coverage and `npm run checks:full` for an explicit uncached full run. Missing Git
history, unsupported paths and global toolchain inputs widen visibly rather than
producing an empty green plan.

CI does not run this affected selection. `.github/workflows/full-validation.yml`
runs the whole suite on GitHub-hosted runners for every push to `main` and every
pull request into it. A newer push to a pull request cancels its older run; on
`main` a run in progress finishes and later pushes collapse into one waiting run. The release workflow accepts a tag only when a push or manual run of
that workflow passed at the exact tagged commit.

A scheduler is optional: without one, these commands run locally with bounded
unit workers and the E2E lane lock. To integrate a host scheduler, put a JSON
`{"command":["/absolute/path/to/scheduler"]}` in
`~/.config/omnesis-dev/scheduler.json` (outside the application config directory).
The adapter accepts `run --kind <kind> -- <command> <args...>`, `status`, and
`cancel <id>`, preserves exit codes and stdout/stderr, and sets
`OMNESIS_TEST_SCHEDULER_ACTIVE=1` in admitted children to prevent nested queues.
`OMNESIS_TEST_SCHEDULER_CONFIG` selects another config file;
`OMNESIS_TEST_SCHEDULER` selects an executable directly (`0` disables admission).
Host capacity and CI priority belong to that adapter's local policy, not the
application configuration. Full unit runs default to at most four workers
(`OMNESIS_UNIT_WORKERS=1..8` overrides); focused file/package checks use at most
two and bypass heavy-job admission. Broad filters such as `packages/` still queue.
`npm run test:e2e -- --who --json` inspects fallback lane ownership without
starting tests; `--status-file <path>` records its queue and phase lifecycle.

When the host has managed checks configured, `npm run checks:status` identifies
running and queued jobs; `npm run checks:cancel -- <id>` cancels a job by its
recorded identity. Cancel your jobs and wait for termination before removing
their worktree. A queued job is still alive and still needs its checkout.
Use the reported job state and exit result to distinguish waiting, failure,
and successful completion. A notification that a shell waiter finished is not
proof that tests passed. Keep job records and logs outside tracked files.

The test commands emit concise `[tests]` file-completion lines alongside the
normal Vitest output. Each run announces a temporary progress-file path. Set `OMNESIS_CHECK_PROGRESS_FILE` to a writable path
outside the checkout for atomic JSON progress (state, completed and failed file
counts, and the most recently completed file). Its parent directory must exist.
Counts describe one Vitest invocation; a new E2E phase or unit sub-lane resets
them. Use the outer command exit code for the complete check result.

Do not infer failure from expected gateway warnings, or success from their
absence. Inspect the test result and exit code. Avoid overlapping independent
full unit, E2E, and lint runs on an unmanaged host; an E2E lock only coordinates
other invocations of that launcher, not every process consuming memory.

## Linting a fresh worktree

**Trap.** The OpenClaw compatibility entry imports
`packages/agent-integration/dist/openclaw.js`. That is a deliberate compiled
runtime entry, so an unbuilt checkout can report `import-x/no-unresolved` even
though the TypeScript source exists.

**Fix.** Use `npm run lint`, which prepares the integration package before
linting and supplies the shared Node heap default. If invoking ESLint directly,
first run `npx tsc --build packages/agent-integration`. This incremental package
build is sufficient; do not suppress the unresolved-import rule or copy another
worktree's compiled files. Extra heap permits ESLint's type-aware program to
fit but does not reserve physical memory against concurrent jobs.

## Migration numbers collide after rebasing

**Trap.** A branch appends a migration while another change takes the same next
schema version on `main`. Keeping both entries at that version or overwriting
the migration already on `main` breaks the append-only upgrade chain.

**Fix.** Rebase onto the current `main` and preserve every migration already
there. Renumber only your branch's unshipped additions, in their original order:

1. Read `LATEST_SCHEMA_VERSION` in
   `packages/gateway/src/data/schema-version.ts` on the updated base; assign your
   additions consecutive versions immediately after that head.
2. Update their entries in `packages/gateway/src/data/migrations.ts`, any numbered
   helper and test filenames, imports, exported names, and version-specific test
   expectations. Set `LATEST_SCHEMA_VERSION` to the final appended version.
3. Advance the pinned seed in
   `packages/gateway/src/data/migration-idempotency-seed.ts` as required by
   `docs/conventions.md`, preserving an accurate historical schema at least
   three versions behind the new head. Update DDL and expected transforms when
   needed; never just relabel a schema that does not match that version.
4. Run your migration tests plus `schema.migration.test.ts` and
   `migration-idempotency.test.ts` through `npm run test:unit:vitest -- <paths>`.
   The former checks contiguity and head consistency; the latter checks real
   first-boot upgrade and second-boot idempotency. Complete the final full gates.

If the old branch migration ran in your disposable development instance,
recreate that instance's test state before testing the renumbered chain. Never
rewrite a live database's version or renumber a migration already shipped.

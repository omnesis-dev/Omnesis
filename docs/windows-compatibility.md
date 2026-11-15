# Windows runtime compatibility audit

This audit covers running the TypeScript product manually on Windows. Windows
installation scripts remain out of scope. The audit is incomplete; the results
below do not establish general Windows support.

## Acceptance criteria

- Run the Gateway, Collector and CLI in actual Windows guests with invented data.
- Validate Windows ARM64 and x64 runtimes, recording the guest and Node architecture.
- Exercise source and compiled entrypoints, native dependencies, worker threads,
  subprocesses, TLS, pairing, sync, search, analytics, persistence and shutdown.
- Every test without a fundamental product reason to be platform-specific must
  pass on Windows. Port generic shell fixtures rather than excluding them.
- Exclude installation tests and installer shell scripts. Preserve assertions
  for integrations that fundamentally require another operating system.
- Prove Linux and macOS regression safety with native validation.
- Keep fixes and evolving evidence in one pull request.

## Continuous integration

The proposed workflow runs focused Windows tests on pull requests and a broad
sweep daily at 04:43 UTC. The daily sweep includes units, adapter tests,
typechecks, two spawned-gateway shards and portal browser tests. All jobs use
GitHub-hosted runners and read-only repository permissions. Real embedding
coverage uses the pinned CPU model; its pins are checked against the existing
Docker embedding lane. Scheduled execution begins only after the workflow
reaches the default branch.

The schedule separates Windows from the existing 01:17 and 13:17 UTC full
sweeps and avoids the top of the hour, when GitHub documents higher scheduling
load. This is a spacing decision, not a guarantee of immediate runner admission.
The broad sweep uses at most four standard runners concurrently; pull requests
use one focused runner and supersede older runs for the same pull request.
Standard hosted runners are free for public repositories under GitHub's
[current billing policy](https://docs.github.com/en/actions/concepts/billing-and-usage).
Runner occupancy and feedback time still matter; completed broad-run timings
must establish the daily workload before the audit is complete. GitHub also
documents that [scheduled runs can be delayed](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows).

The measured broad PR selection took 34 minutes, including 25 minutes for its
unit phase. Six CLI/service decision matrices accounted for more than half of
reported unit-file runtime. Those matrices run in the complete daily/manual
Windows unit sweep; PRs retain native filesystem/process boundaries, lifecycle
regressions, CLI integration and real Gateway/Collector smoke tests. The complete
sweep continues to discover every portable unit suite normally.
The revised selection passed 3,618 unit tests and 14 real Gateway/Collector smoke
tests. Its unit phase took 10 minutes and the complete job took 18 minutes;
runner admission waited 4 seconds.

`node scripts/ci/windows-checks.mjs unit --list` prints the broad unit plan.
The same entrypoint accepts `focused`, `e2e` and `portal`. Installer exclusions
have explicit reasons. Manual dispatch defaults to the complete sweep and can
select units, both E2E shards, or the portal for diagnosis. An E2E-only manual
run can also supply `e2e_files`, a JSON array of one to sixteen existing
repository E2E paths. This creates one unsharded diagnostic job; it does not
change pull-request or daily coverage. Paths are validated and passed as literal
Node arguments, never interpolated into shell source.

Platform-specific cases remain explicit in their suites. The Unix topology and
process-group shell helpers exercise `lsof`/`ss`, `pgrep` and Unix signals on
Linux/macOS. Windows still runs the portable HTTP liveness checks and the other
Bash fixtures through Git for Windows. The Screen Time physical Full Disk Access
fixture remains specific to its macOS permission contract; portable denial
mapping tests still validate the same remediation logic on Windows.

The first complete Windows unit baseline took about 163 minutes. Its failures
and helper initialization costs must be resolved before treating that as a
representative daily runtime. Product operation deadlines remain enforced;
changes to multi-stage fixture budgets are recorded with their evidence below.

## Native Windows evidence

Targeted follow-up validation passed all 44 real Gateway/Collector tests across
eight files on Windows, including Collector parent shutdown and fleet doctor
commands. The relay suite passed 2,225 tests with 15 conditional skips and 100%
statement, branch, function and line coverage. Process ownership and encrypted
bootstrap-reader regressions also passed on Linux and Windows, run sequentially.
These focused results do not replace the pending complete-suite validation.

Windows source preparation explicitly builds the patched SQLite and vector
dependencies before starting the product or its compiled entrypoints:

```sh
node scripts/ci/build-windows-sqlite.mjs
node scripts/ci/build-windows-usearch.mjs
```

Run these from an isolated checkout after installing its locked dependencies.
The native builds require MSVC and Python and verify the running Node version's
headers before compilation.
The SQLite backport preserves the existing engine and encryption format. It
applies the upstream Windows shared-memory recovery fix: under the exclusive
dead-man-switch lock, a still-mapped shared-memory file is reset by writing its
header when Windows refuses truncation. This follows SQLite's
[upstream fix](https://sqlite.org/forum/info/ba7afbd0e81501118563617430fe06d0aca052e55ece2b0d457f8e16fcf85bba?t=c).
The source preparation verifies the default installed bindings and a complete
encrypted Gateway schema; tests hold a stale mapping through recovery. Linux
and macOS retain their existing prebuilt libraries. This preparation remains
separate from Windows installation support, which is outside the audit.

Authentication subprocesses also exercise an existing encrypted credential in
a restricted Windows environment. Native process identity uses exact framework
creation-time ticks, and compiler bootstraps load the system utility module by
its absolute path; neither requires an inherited module discovery path. The
targeted regression run passed all 128 tests on Windows, including native cache
and bootstrap security cases. Linux passed 103 tests with 25 Windows-specific
skips. Full source/test typechecks and lint passed for the same source snapshot.

Manual acceptance of source revision `686a43ef0` passed on hosted Windows with
both source and compiled entrypoints. Each mode initialized encrypted storage,
booted the real Gateway and Collector, paired the Collector, synchronized three
invented Obsidian documents, and exercised JSON status, search, document reads,
SQLite and DuckDB analytics. After stopping both daemons, the restart checks
proved offline status, an actually online Collector, and the same persisted
document IDs. Keyless encrypted-database opens were refused, with an ordinary
unencrypted database as the negative control. Every daemon stopped with exit code 0
and a confirmed process-tree join; no forced fallback or cleanup uncertainty
occurred. The job waited 4 seconds and ran 11 minutes 14 seconds. This is manual
runtime evidence for that revision, not a passing broad suite or final tree.

The focused x64 run at revision `11f70451d` passed all 1,889 unit tests across
137 files, with 27 conditional skips. All 13 gateway E2E tests passed in about
100 seconds, including gateway ownership, replacement during drain, stale-lock
recovery and synthetic collector sync. This includes native private-copy,
permission, Codex-state and harness process tests. The full Windows portal run
at `456dffb02` passed all 70 tests. Broad compatibility remains unproven.

The vector proof exercised Unicode paths, replacement with an old mapped reader
still open, dimensionality changes, read-only targets, failed publication
retaining the previous index, explicit disposal and a sparse file over 4 GiB.
A passing dependency proof is not a passing runtime lane.

The worker cache failures exposed a path representation boundary: .NET expands
DOS short-name ancestors while JavaScript verifies the requested path spelling.
The fix checks the canonical path while verified ancestor handles remain pinned,
then returns the requested spelling. Owner, creation-time, DACL, reparse-point,
generation, binary-hash and transferred-handle checks remain enforced. Native
cold initialization, cache reuse and security regressions must pass together.

An actual ARM64 guest boots with hardware acceleration and runs Node 24. Its
process-creation metadata query completes in 1.9 seconds within the unchanged
10-second deadline. Earlier native probes exercised binary-safe process
ownership and NTFS case-sensitive directory containment. The Local Files boundary refused a distinct
sibling differing only in case before reading its bytes, while accepting an
alias for the same directory. This is narrow evidence: complete ARM64 native
dependencies and product validation remain open, and the provider remains gated.

Native crash handling now reports an exact nonce-bound native-open stage. Known
Windows fault statuses can trigger quarantine only inside that unfinished stage;
unknown failures there refuse an in-process open while preserving the file.
A failed quarantine also refuses the unsafe open. Ordinary startup exit codes,
including code 3, remain inconclusive. Node abort status 134 is recognized only inside the trusted native-open stage,
with explicit Node out-of-memory diagnostics refused without quarantine on both
Windows and POSIX. Controlled abort and exit fixtures cover this distinction.
On the actual Windows x64 Node 24.22.2 runner, both the MSVC abort and terminate
diagnostics returned `0xc0000409`, one of the guard's recognized native fault
statuses. The focused control-channel tests passed. Ordinary code 3 remains
unclassified. Linux signals and explicit file-rejection handling retain
regression coverage.

An ARM64 current-module probe found that metadata-only directory handles did
not enforce delete-sharing exclusion. Deny-delete directory pins now request
traversal access; read-only metadata inspection keeps its existing rights. At
`7229de62e`, the native rerun passed all 30 platform checks: each cache ancestor
and generation rejected rename while remaining usable, and a streamed write
kept its publication parent pinned and its previous bytes intact until commit.
Other cases covered private ACLs, atomic/readonly/no-clobber publication, literal
arguments, binary framing, junction and case-sensitive containment, completion,
cancellation and parent death. Wait was zero seconds; execution took 4 minutes
1 second, with graceful guest shutdown. x64 Node also ran in that ARM64 guest;
x64 native dependency preparation and the MSVC vector publication proof also
passed. Full Gateway/Collector runtime validation remains separate.

A subsequent process/helper probe passed all 33 groups, including exact process
birth matching, parent handle lifetime and raw Node descendant/port cleanup.
An extended private-copy probe passed 40 of 41 groups. Its remaining fixture
incorrectly assumed that an RD-only ACL denial would also make Node's ordinary
reader fail. A separate native diagnostic confirmed that private copy refuses
that source, preserves previous destination bytes and leaves no scratch file.
The corrected complete probe and current native inspection changes still need
fresh Windows validation.

Windows does not provide an atomic identity-conditional replacement for a regular
file held open without delete sharing. The controlled NTFS probe confirmed that
both rename and hardlink replacement fail with sharing violation32 under that
pin; allowing delete sharing would permit ordinary external publishers, including
Codex credential refresh, to replace the name during a copy. Generic online
repair therefore refuses existing broad/unsafe file DACLs unchanged. No range
lock or escrow publication protocol is used.

A file whose current DACL is already private may have inheritance sealed through
its exact retained handle. The helper keeps the same owner and normalized grant
and deny ACEs; only inheritance protection changes. A READ_DATA right activates
deny-delete sharing during sealing, but no content bytes are read. Existing
read/write handles and private hardlink aliases remain compatible; if the pin or
WRITE_DAC right is unavailable the operation refuses. Already-protected private
files remain a metadata-only no-op. All byte streams, extended attributes, creation and modification times,
readonly flags and file identity stay untouched, including on refusal. Directory
repair remains single-object and does not propagate changes into existing files.
New private writes and fixed-buffer copies retain protected creation before bytes,
held-parent atomic publication and existing no-clobber guarantees.

Bootstrap repair never reads file bytes or applies config values, and a successful
early seal still exits with status2 for review/rerun. Broad-access files require
stopping related applications and reviewing or recreating their access controls.
The narrowed inheritance-sealing path and fresh cold compiler cache still require
actual Windows execution before they are considered verified.

Actual x64 dependency preparation, encrypted keyring initialization, the compiled
CLI and all six compiled gateway worker entrypoints passed in the ARM64 guest.
Initial source and compiled manual Gateway observations ended during encrypted
storage initialization. Separate public storage diagnostics subsequently
initialized all seven host keys and resolved the configured encrypted storage.
A longer diagnostic then exposed a concrete Gateway failure while its writer
initialized the protected native helper for bootstrap-token publication; the
Collector never launched. The bootstrap operation now rolls back its SQLite
rows when private-file publication fails, so retry does not strand the install.
Native worker initialization and complete manual Gateway/Collector validation
remain open; isolated main-thread and Worker initialization passed without
reproducing the full startup failure. No product deadlines were raised.

A verified worker-cache generation is now shared with subsequently created
Node Workers in the same process, avoiding repeated trusted bootstrap work.
The seed is bound to the process ID, exact source generation and cache path;
failed initialization remains sticky, and workers without a valid seed perform
full verification. Native execution and a successful complete Gateway start
are still required before attributing the startup failure to this overhead.

Portable follow-ups preserve exact 64-bit filesystem identities in disk usage,
use the native home when a shell has no `HOME`, write slash-separated ZIP entry
names, and distinguish Windows drives in uninstall containment. Uninstall also
recognizes escaped service references before removing a shared CLI. Focused
regressions retain Linux/macOS behavior, including real hard-link deduplication,
explicit home/config overrides and Unix service quoting.

The focused Windows run at `f84413d74` passed 2,838 unit tests and failed 19,
with 34 conditional skips. All 13 gateway E2E tests passed. The native vector
build/publication proof and source/test typechecks passed. Remaining failures
include process-tree cancellation, native file repair, permission fixtures and
asynchronous test setup; these must pass at a fresh source checkpoint.

## Broader failing baselines

The complete Windows unit baseline at `3c076e8e3` recorded 35,642 passing tests,
1,879 failures and 89 skips: 2,319 files passed, 232 failed and four were skipped.
It also reported 16 unhandled errors. Both Windows gateway E2E shards completed:
102 files passed and 26 failed in one; 100 passed, 26 failed and one skipped in
the other. The portal exposed excessive native-helper startup overhead.

The later broad Windows baseline at `bbc97b2ac` passed 37,227 unit tests and
failed 584, with 86 skips: 2,428 files passed, 152 failed and four were skipped.
That unit phase took about 122 minutes. E2E shard one passed 712 tests and failed
ten; shard two passed 620 and failed five. These results precede the current
fixture, privacy and lifecycle corrections and require a new broad run.

The broad unit run at `11f70451d` passed 38,121 tests and failed 239, with
123 skips: 2,564 files passed, 66 failed and six were skipped. Its unit phase
took about 90 minutes. The portal lane passed all 70 tests. E2E shard one
passed 733 tests and failed four; shard two passed 643 and failed seven, with
13 conditional skips. The E2E phases took about 143 and 146 minutes. The four
jobs consumed roughly seven runner-hours together, with at most four jobs
concurrent. The daily schedule separates this workload from the existing full
validation sweeps. These results precede subsequent runtime and fixture
corrections and do not establish a passing daily baseline.

Those baselines identified Unix-only process control, npm/shebang execution,
Windows filesystem flushing, private-file protection, mapped-index publication,
temporary paths, certificate line endings and resource lifecycles. Fixes and
focused regressions cover these areas, but a fresh complete Windows verdict is
required. Skipping portable tests is not an acceptable resolution.

## Regression evidence

The frozen Linux checkpoint at `d396be7ca` passed 39,307 general unit tests,
161 script smoke tests and 1,828 relay tests, with 100% relay statement, branch,
function and line coverage. Source/test typechecks passed. Unit-all waited
17 seconds and ran for 46 minutes 10 seconds. Its affected gate subsequently
passed its selected E2E and native bundles. This frozen checkpoint predates
newer fixes and main-branch changes, so it does not validate the final tree.

The hosted macOS run at `11f70451d` passed all 39,217 TypeScript unit tests;
one Python fixture incorrectly expected symlink-canonicalized temporary paths.
The hosted Linux run passed 39,368 unit tests and failed one lexical-ranking
fixture whose parity assertion depended on completing within a real 25 ms
budget under load. The follow-up uses a controlled clock for parity and retains
explicit deadline/fallback coverage, and corrects the Python path expectation.
Both native operating-system lanes must validate the final tree.

Four live embedding transition cases pass on Linux with real CPU inference:
HTTP-to-HTTP, HTTP-to-local, local-to-HTTP and local-to-local. The latest frozen
worker-shutdown slice waited zero seconds and ran for 3 minutes 13 seconds.
It verifies ongoing vector search through generation and dimension changes,
publication and worker handoff. Native workers drain inference before shutdown;
acknowledgment and actual thread exit are both joined before handle cleanup.
At `7c825ab28`, Windows passed all four transitions with real CPU embeddings.
The four-test file took 207 seconds in the broad sweep's second E2E shard;
that shard passed 691 tests across 130 files, with two conditional skips.
These immutable-snapshot results still require final-head revalidation.

At `53f02f142`, Linux typechecks, lint, portal E2E, embedding E2E, both Docker
runtime architectures, Docker smoke tests and integration harnesses passed.
The broader unit and E2E results remain under review. The macOS typecheck passed,
but its unit lane failed: failures include temporary-directory aliases, an
incomplete installer fixture export and a private-content assertion matching a
system directory name. Corrections pass 655 focused Linux regressions, including all affected installer
files; native macOS validation is still required. A final frozen-source Linux
and macOS verdict, alongside Windows, remains mandatory.

The complete Linux unit run at `7229de62e` passed 38,824 tests and failed eight
tests in three files. These failures exposed machine-readable subprocess output
being colored and Node warnings from conflicting color settings. Corrections and
a fresh complete verdict are required. Queue wait was zero seconds and execution
took 42 minutes 23 seconds.

At the frozen process-cleanup follow-up, an accelerated Windows ARM64 probe
passed all 33 cases, including the earlier 30 platform checks. Exact process
births, a one-tick nontermination check, retained-parent handle lifetime,
termination and socket reuse passed. Warm snapshots took 0.4 seconds; raw Node
runner cleanup released its detached descendant's port in 2.9 seconds. Cold
initialization stayed within its unchanged deadline. Queue wait was 2 seconds;
execution took 4 minutes 30 seconds, including graceful guest shutdown.

The hosted Linux run at `7229de62e` passed 39,221 general unit tests, 161 installer
regressions and 1,811 relay tests, but failed strict coverage in two relay
identity-protection files. The follow-up passed all 1,828 relay tests across 188
files with 100% statements, branches, functions and lines for every covered file.
Queue wait was zero seconds; execution took 58 seconds.

Provider review additionally found rounded filesystem IDs could mix up Obsidian
notes during simultaneous rename and edit. Exact identities now distinguish
those notes while preserving installed IDs during upgrade; replacement files
retain their separate identities. All 115 provider tests passed. Windows Arc
discovery now checks the vendor package family and requires an actual Chromium
history layout; 91 browser-provider tests passed. Actual installed Arc profile
validation and Obsidian case-sensitive containment proof remain required.

At `c0d108019`, focused Windows coverage passed 1,725 unit tests across 117 files
(25 conditional skips) and all 13 gateway E2E tests. The E2E phase completed in
134 seconds, including the original synthetic-pipeline teardown bound.

The native replay at `3b6a93d86` passed all 71 checks: filesystem and process
lifetimes, private traversal, metadata and control probes, bounded 64MiB reads,
and direct PowerShell regressions. Queue wait was zero seconds; execution took
7 minutes 50 seconds, including clean guest shutdown. This validates the native
foundation, not complete Gateway or Collector operation. The concurrent publisher
fixture exercises modern Windows replacement semantics and separately proves
legacy replacement refusal leaves the held file unchanged.

At `ee42b7905`, hosted Windows focused coverage passed 3,640 tests and failed 19,
with 38 conditional skips; its three smoke E2E files passed all 13 tests. The
follow-up corrects fixtures that still expected unsafe file ACLs to be repaired
online, native path and command quoting assumptions, and decoder-timeout tests
that confused helper startup with confirmed process cleanup. Every portable
suite still requires a passing fresh verdict.

A targeted Windows run of 13 remaining E2E files passed 81 tests and failed eight,
with 11 conditional skips. Remaining failures cover relay enrollment, candidate
work after restart, independent updater ownership, Maildir fixture disposal and
write/checkpoint latency. These are unresolved until their fixes pass Windows;
performance budgets and durability requirements remain unchanged.

The complete two-shard Windows E2E baseline at `391fc2566` passed 1,389 tests,
failed 13 and skipped 15 across 258 files. Twelve files failed. Both shards
finished inside their existing 180-minute limits; neither is a passing verdict.

A controlled follow-up compared identical SQLite checkpoint workloads on both
temporary-storage locations of one hosted Windows runner. Moving only `TMP` and
`TEMP` to runner temporary storage reduced scattered 2,048-page checkpoints from
roughly 2.3–2.5 seconds to 147–208 milliseconds across the ordinary SQLite driver,
the encryption-capable driver without encryption, and the encrypted driver.
The original writer checkpoint, maintenance and near-duplicate backlog suites
then passed all 10 tests at `29c0ab57a` using that storage. Their latency limits
and durability settings were unchanged. The workflow selects that storage only
for these raw SQLite latency fixtures through `OMNESIS_TEST_SQLITE_TMP`; private
file fixtures keep their normal temporary-directory policy. That narrower
selection still requires a fresh run of the same 10 tests.

At that checkpoint the retained-exit and watchdog suites also passed all 15
tests on Linux, including real stalled-process controls. The new test first
failed against the preceding watchdog because active owned work did not prevent
its forced restart. Final integrated Collector and whole-suite evidence is still
required.

The hosted Linux general unit phase at `ee42b7905` passed 39,941 tests, its script
smoke phase passed 162, and its relay phase passed 1,999. The job nevertheless
failed the strict per-file relay coverage gate in seven changed files. Passing
assertions alone do not establish a passing lane; complete coverage and final
Linux/macOS validation remain required.

At `391fc2566`, hosted Windows focused coverage passed 3,654 tests and failed 14,
with 38 conditional skips. All 13 smoke E2E tests passed. The remaining focused
failures include ACL fixture restoration, an output-link expectation, a fixture's
inherited permission removal and a multi-stage OAuth timeout. The full Windows
portal run passed all 71 browser tests in 237 seconds. The two full
spawned-gateway shards completed with the failures recorded above.

The broad unit job completed in about 102 minutes. Its general unit phase passed
38,886 tests and failed 41; its script smoke phase passed 138 and failed 23.
These include additional fixture assumptions and runtime failures requiring
correction. The three-attempt OAuth recovery scenario completed in 19.834 seconds
in this run but exceeded its 30-second outer test limit in the focused run.
That scenario has a 60-second test budget for all three complete connection
attempts, retaining the individual helper deadlines and every recovery assertion.

The targeted restart run at that revision passed Maildir's nine tests and the
independent updater test. One candidate-decision case still failed: work admitted
during replacement startup received a due time beyond the restored frozen clock.
The follow-up initializes the explicitly enabled virtual test clock before
startup work is admitted, using the harness's last saved instant. Production's
normal clock is unchanged. Fresh Windows verification remains required.

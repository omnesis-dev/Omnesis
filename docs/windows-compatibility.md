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

`node scripts/ci/windows-checks.mjs unit --list` prints the broad unit plan.
The same entrypoint accepts `focused`, `e2e` and `portal`. Installer exclusions
have explicit reasons. Manual dispatch defaults to the complete sweep and can
select units, both E2E shards, or the portal for diagnosis. An E2E-only manual
run can also supply `e2e_files`, a JSON array of one to sixteen existing
repository E2E paths. This creates one unsharded diagnostic job; it does not
change pull-request or daily coverage. Paths are validated and passed as literal
Node arguments, never interpolated into shell source.

The first complete Windows unit baseline took about 163 minutes. Its failures
and helper initialization costs must be resolved before treating that as a
representative daily runtime. No product or test deadlines were raised to hide
those failures.

## Native Windows evidence

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

Unsafe file permission repair uses a fixed-buffer copy into an initially private
file and publishes it through the held parent. It does not modify the old file
object's DACL or readonly attributes; aliases that appear during copying retain
that object's original bytes and access controls. Ordinary canonical publishers
honor deny-delete pins; only the repair's own atomic publication uses POSIX
replacement while its source is held. Arbitrary same-user POSIX replacements
outside this protocol are not an isolation boundary. An initially multi-linked,
busy unsafe or unreadable source is refused. Already-private busy files still
need no mutation. Creation and write timestamps and the readonly setting are
preserved on the replacement, together with ordinary hidden, system, archive,
temporary and not-content-indexed attributes. EFS encryption and other storage
semantics needing dedicated preservation APIs fail closed before content reads;
the deterministic EFS-metadata refusal case does not establish physical EFS
execution. Exact-entry deletion and staging cleanup use
native ignore-readonly disposition rather than clearing shared attributes;
unsupported filesystems fail closed. Bootstrap repair never returns file bytes
to the dotenv loader or applies config values, and still exits with status 2.
Controlled after-check hardlink, failed-publication and denied-read regressions
require fresh native execution before this repair path is considered verified.

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
Windows execution of this coverage remains required.

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

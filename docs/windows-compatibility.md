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
select units, both E2E shards, or the portal for diagnosis; daily coverage remains
broad.

The first complete Windows unit baseline took about 163 minutes. Its failures
and helper initialization costs must be resolved before treating that as a
representative daily runtime. No product or test deadlines were raised to hide
those failures.

## Native Windows evidence

The focused x64 run at revision `7229de62e` passed all 1,657 unit tests across
112 files, with 25 conditional skips. All 13 gateway E2E tests passed, including
gateway ownership, replacement during drain and stale-lock recovery. The earlier
synthetic pipeline teardown failure did not recur in this run; process cleanup
is still being improved and requires fresh native validation. The full Windows
portal run at `456dffb02` passed all 70 tests.

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
Automatic recovery for a Windows CRT abort remains open until its actual native
status contract is established;
Linux signals and explicit file-rejection handling retain regression coverage.
Fresh Windows control-channel and recovery proof are still required.

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

## Broader failing baselines

The complete Windows unit baseline at `3c076e8e3` recorded 35,642 passing tests,
1,879 failures and 89 skips: 2,319 files passed, 232 failed and four were skipped.
It also reported 16 unhandled errors. Both Windows gateway E2E shards completed:
102 files passed and 26 failed in one; 100 passed, 26 failed and one skipped in
the other. The portal exposed excessive native-helper startup overhead.

Those baselines identified Unix-only process control, npm/shebang execution,
Windows filesystem flushing, private-file protection, mapped-index publication,
temporary paths, certificate line endings and resource lifecycles. Fixes and
focused regressions cover these areas, but a fresh complete Windows verdict is
required. Skipping portable tests is not an acceptable resolution.

## Regression evidence

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

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

The focused x64 run at revision `53f02f142` passed native dependency preparation
and the MSVC vector binding proof. The proof exercised Unicode paths, replacement
with an old mapped reader still open, dimensionality changes, read-only targets,
failed publication retaining the previous index, explicit resource disposal and
a sparse file larger than 4 GiB.

Its unit phase passed 1,456 tests, failed 88 and skipped 24, across 99 passing
and nine failing files. E2E did not run after that failure. Remaining groups
include native worker cache verification, SQLite fixture cleanup, native paths,
command fixture escaping and CRLF comparisons. Corrected groups require fresh
Windows results; a passing native dependency proof is not a passing runtime lane.

The worker cache failures exposed a path representation boundary: .NET expands
DOS short-name ancestors while JavaScript verifies the requested path spelling.
The fix checks the canonical path while verified ancestor handles remain pinned,
then returns the requested spelling. Owner, creation-time, DACL, reparse-point,
generation, binary-hash and transferred-handle checks remain enforced. Native
cold initialization, cache reuse and security regressions must pass together.

An actual ARM64 guest has exercised binary-safe process ownership and NTFS
case-sensitive directory containment. The Local Files boundary refused a distinct
sibling differing only in case before reading its bytes, while accepting an
alias for the same directory. This is narrow evidence: complete ARM64 native
dependencies and product validation remain open, and the provider remains gated.

Automatic vector-index recovery after a native crash remains an open Windows
parity item. Ordinary child exit codes, including code 3, are inconclusive and
must preserve the file. The native abort probe checks parent survival and file
preservation on Windows; matching Unix recovery requires evidence from an actual
corrupt-index open and a trustworthy native-open boundary.

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

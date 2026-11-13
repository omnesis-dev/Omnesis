# Windows runtime compatibility audit

This audit covers running the TypeScript product manually on Windows. It does
not add a Windows installer or claim support for operating-system integrations
that a provider explicitly restricts to another platform.

## Acceptance criteria

- Run the Gateway, Collector and CLI in actual Windows guests with invented data.
- Validate Windows ARM64 and x64 runtimes, recording the guest and Node architecture.
- Exercise source and compiled entrypoints, native dependencies, worker threads,
  subprocesses, TLS, pairing, sync, search, analytics, persistence and shutdown.
- Every test without a fundamental product reason to be platform-specific must
  pass on Windows. Shell-based fixtures must be ported rather than excluded.
- Installation tests and installer shell scripts are excluded from this audit;
  platform-only integrations retain their operating-system-specific assertions.
- Preserve Linux and macOS behavior with regression tests and native validation.
- Keep all fixes and the evolving evidence in one pull request.

## Findings and validation

| Area                   | Finding                                                                              | Current evidence                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway startup        | The claim guard only implemented Linux and macOS locking.                            | Windows guard implemented; existing Linux lifecycle tests pass. Actual Windows execution pending.                                                                                                       |
| External processes     | Cancellation used Unix negative-PID process groups on Windows.                       | Windows tree termination implemented; launcher fixtures now use Node so the same tests can run on Windows. Linux launcher suite passes. Windows execution pending.                                      |
| Hosted widgets         | Registration required an absolute path beginning with `/`.                           | Validation uses the host path implementation; host-filesystem regression test passes on Linux. Windows execution pending.                                                                               |
| JavaScript executables | Windows cannot execute a JavaScript shebang or an npm batch shim through `execFile`. | Node/npm argv helpers and Codex/CLI call sites updated. The complete 70-test Codex backend suite passes on Linux, including its managed runtime. Windows execution pending.                             |
| Browser authorization  | Windows browser opening treated `start` as an executable.                            | Literal URI handling through PowerShell, with regression coverage for shell metacharacters. Windows execution pending.                                                                                  |
| Local paths            | Home expansion depended on `HOME`; vault link keys used native separators.           | Native home resolution, Windows home prefixes, slash-based Obsidian identities and Windows browser-profile discovery implemented. Focused Linux provider and CLI tests pass. Windows execution pending. |
| Encrypted analytics    | Bundled DuckDB extension pins omitted Windows.                                       | Upstream Windows x64 `httpfs` binary pinned; all nine extension-download tests pass on Linux. Native Windows ARM64 extension availability remains under investigation.                                  |

## Continuous integration

The proposed Windows workflow has one focused pull-request job and a daily
sweep at 04:43 UTC. The daily sweep includes broad units, two spawned-gateway
shards and portal browser tests. It uses GitHub-hosted Windows runners and
read-only repository permissions. The embedding tests use the real pinned
reference model through a portable CPU server; its model pins are checked
against the existing Docker embedding lane.

`node scripts/ci/windows-checks.mjs unit --list` prints the broad unit plan;
the same entrypoint accepts `focused`, `e2e` and `portal`. Installer exclusions
carry explicit reasons in that entrypoint. The workflow becomes scheduled only
after it reaches the default branch.

The audit is in progress. Passing Linux tests and inspecting Windows-specific
branches do not establish Windows compatibility. Native dependency installation,
the broader runtime surface, Windows lifecycle tests and macOS regression checks
remain to be completed.

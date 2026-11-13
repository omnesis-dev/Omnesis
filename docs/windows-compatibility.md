# Windows runtime compatibility audit

This audit covers running the TypeScript product manually on Windows. It does
not add a Windows installer or claim support for operating-system integrations
that a provider explicitly restricts to another platform.

## Acceptance criteria

- Run the Gateway, Collector and CLI in actual Windows guests with invented data.
- Validate Windows ARM64 and x64 runtimes, recording the guest and Node architecture.
- Exercise source and compiled entrypoints, native dependencies, worker threads,
  subprocesses, TLS, pairing, sync, search, analytics, persistence and shutdown.
- Run the TypeScript unit and integration suites; investigate failures rather
  than broadly skipping suites or treating mocked platforms as Windows evidence.
- Preserve Linux and macOS behavior with regression tests and native validation.
- Keep all fixes and the evolving evidence in one pull request.

## Findings and validation

| Area               | Finding                                                        | Current evidence                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway startup    | The claim guard only implemented Linux and macOS locking.      | Windows guard implemented; existing Linux lifecycle tests pass. Actual Windows execution pending.                                                                  |
| External processes | Cancellation used Unix negative-PID process groups on Windows. | Windows tree termination implemented; launcher fixtures now use Node so the same tests can run on Windows. Linux launcher suite passes. Windows execution pending. |
| Hosted widgets     | Registration required an absolute path beginning with `/`.     | Validation uses the host path implementation; host-filesystem regression test passes on Linux. Windows execution pending.                                          |

The audit is in progress. Passing Linux tests and inspecting Windows-specific
branches do not establish Windows compatibility. Native dependency installation,
the broader runtime surface, Windows lifecycle tests and macOS regression checks
remain to be completed.

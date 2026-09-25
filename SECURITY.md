# Security Policy

Omnesis indexes deeply personal data — emails, messages, notes, calendar
events, browser history, health metrics. A vulnerability in Omnesis is a
vulnerability against its users' most private digital life. We take that
seriously.

## Supported versions

Omnesis is pre-1.0. All `@omnesis/*` packages version in lockstep as a single
product version, cut as tagged releases (`vX.Y.Z`) and served on `GET /health`.
Security fixes land on `main`, are cut into the next tagged release, and reach
users via `omnesis update`.

Being pre-1.0, only the latest tagged release receives security fixes; there are
no separately maintained release branches or back-ported patches.

| Version                  | Supported |
| ------------------------ | --------- |
| Latest tagged release    | ✅        |
| Older releases / commits | ❌        |

Once Omnesis reaches 1.0 this table will define a support window per major
version.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/omnesis-dev/Omnesis/security/advisories/new>
2. Fill in the form with as much detail as possible.

If for any reason private reporting is not available to you, email
<contact@omnesis.dev>.

Include in your report:

- A description of the issue and its impact.
- Steps to reproduce (ideally a minimal proof of concept).
- The affected version / commit SHA.
- Any suggested mitigation or fix, if you have one in mind.

## What to expect

- **Acknowledgement** within **5 business days**.
- **Initial assessment** (severity, scope, affected components) within
  **14 days**.
- **Coordinated disclosure**: we aim to publish a fix and an advisory
  within **90 days** of the initial report, sooner for critical issues.
  If the fix needs longer (e.g. it requires a coordinated release with
  a downstream dependency), we will say so and keep you informed.

## Scope

In scope:

- The gateway HTTP server (`packages/gateway/`) — authentication, scopes,
  token issuance, route handlers, SQL injection surface.
- The collector and source manager (`packages/collector/`).
- Source-specific authentication subprocesses
  (`packages/providers/*/src/`).
- The iOS app (`ios/`) — pairing flow, certificate pinning, on-device
  storage.
- The CLI (`packages/cli/`) — argument handling, file I/O.

Out of scope:

- Vulnerabilities in upstream dependencies (please report those to the
  upstream project; we will still update our pin once a fix is published).
- Denial-of-service attacks that require physical access to the host
  (Omnesis is designed to run on a trusted machine).
- Vulnerabilities in third-party services Omnesis integrates with
  (Gmail, Notion, etc.) — report those to the service operator.
- Social-engineering or phishing attacks against contributors.

## Safe harbour

We will not pursue legal action against good-faith security research that:

- Avoids privacy violations, destruction of data, and interruption or
  degradation of services for users other than yourself.
- Respects the scope above.
- Gives us a reasonable time to address the issue before public
  disclosure.

Thank you for helping keep Omnesis users safe.

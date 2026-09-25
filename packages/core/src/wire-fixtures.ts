// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wire vocabulary, written down once, as bytes.
 *
 * A phone and an external producer speak the same contract as the collector,
 * and until now they learned it by having it re-implemented for them. Three
 * implementations of one vocabulary drift in the direction nobody notices: a
 * value the TypeScript side started sending that Swift silently decodes as
 * absent, an enum arm Kotlin maps to its own default. Each is invisible until
 * a real device meets a real gateway.
 *
 * So the vocabulary is a corpus of checked-in JSON, and every implementation
 * decodes the same bytes. When one of them cannot, the disagreement surfaces
 * in its own test suite rather than in a phone that quietly stopped reporting
 * something.
 *
 * These are deliberately *values*, not schemas. A schema states what is
 * allowed; a fixture states what is actually sent, including the arms that are
 * easy to leave unhandled — an envelope from a version this build does not
 * have, a coverage of `unknown`, a failure that names no quota.
 *
 * `wire-fixtures/` holds the generated files; `wire-fixtures.test.ts` fails
 * when they drift from what these definitions produce, so a contract change
 * that forgets the native clients cannot land quietly.
 */

/** One named example: what it is, and the exact value that goes on the wire. */
export interface WireFixture {
  /** File name under `wire-fixtures/`, without the extension. */
  readonly name: string;
  /** Why this arm exists — read by a person deciding whether to handle it. */
  readonly note: string;
  readonly value: unknown;
}

/**
 * Persisted source state, as the gateway stores it.
 *
 * The last two are the arms a decoder is most likely to get wrong: an envelope
 * from a build ahead of this one must be refused rather than read as empty,
 * and a raw pre-envelope value must be recognised as legacy rather than as
 * corruption.
 */
export const STATE_FIXTURES: readonly WireFixture[] = [
  {
    name: "state-envelope-current",
    note: "A source's state at the version this build writes.",
    value: { e: 1, v: 2, s: "things:local", state: { offset: 12 } },
  },
  {
    name: "state-envelope-with-minor",
    note: "A minor version rides alongside the major; a decoder that ignores `m` still reads the state.",
    value: { e: 1, v: 2, m: 3, s: "things:local", state: { offset: 12 } },
  },
  {
    name: "state-envelope-from-newer-build",
    note: "Written by a build ahead of this one. Must be refused, not read as an empty cursor.",
    value: { e: 1, v: 99, s: "things:local", state: { somethingNew: true } },
  },
  {
    name: "state-legacy-raw",
    note: "A cursor written before envelopes existed. Recognised as legacy, not as corruption.",
    value: { offset: 12 },
  },
];

/** How much a failure took with it, and what budget it spent. */
export const FAILURE_FIXTURES: readonly WireFixture[] = [
  {
    name: "failure-item",
    note: "One upstream item; the page steps over it and keeps going.",
    value: { kind: "unknown", scope: "item", message: "note 404 on detail fetch" },
  },
  {
    name: "failure-connection",
    note: "The credential died, so every source on it is affected whether or not it has noticed.",
    value: { kind: "auth", scope: "connection", message: "grant revoked" },
  },
  {
    name: "failure-rate-limit-app-quota",
    note: "Counted per registered application: backing off one account spends the same budget from another direction.",
    value: {
      kind: "rate-limit",
      scope: "source",
      retryAfterMs: 900000,
      quota: { kind: "app" },
      message: "daily application quota exhausted",
    },
  },
  {
    name: "failure-rate-limit-unattributed",
    note: "A limit naming no budget. Only the source that hit it backs off; a guess would stop sources that were working.",
    value: { kind: "rate-limit", scope: "source", retryAfterMs: 60000, message: "429" },
  },
];

/** What a source claims about how much of its history it holds. */
export const COVERAGE_FIXTURES: readonly WireFixture[] = [
  {
    name: "coverage-complete",
    note: "The source knows it holds everything.",
    value: { phase: "incremental", processed: 40, coverage: "complete" },
  },
  {
    name: "coverage-partial",
    note: "Still fetching older history; live sync is current.",
    value: {
      phase: "bootstrap",
      processed: 40,
      coverage: "partial",
      detail: "catching up on older history",
    },
  },
  {
    name: "coverage-unknown",
    note: "The source cannot establish whether it is missing history. Not a synonym for complete.",
    value: { phase: "incremental", processed: 40, coverage: "unknown" },
  },
  {
    name: "coverage-absent",
    note: "The question does not apply to this source. A client shows nothing, rather than a warning.",
    value: { phase: "incremental", processed: 40 },
  },
];

/** Complete events, rather than fragments that bypass transport validation. */
export const AUTH_CHALLENGE_FIXTURES: readonly WireFixture[] = [
  {
    kind: "redirect",
    title: "Connect account",
    url: "https://example.com/connect",
    via: "elsewhere",
  },
  { kind: "code", title: "Enter code", pattern: "^[0-9]{6}$", patternHint: "Six digits" },
  { kind: "qr", title: "Scan code", data: "fictional-pairing-payload" },
  {
    kind: "fields",
    title: "Enter credentials",
    fields: [{ name: "token", label: "Token", type: "secret", required: true }],
  },
  {
    kind: "widget",
    title: "Connect account",
    renderer: "fixture-widget",
    payload: { token: "fictional-widget-token" },
  },
  { kind: "wait", title: "Approve connection", instructions: "Approve in the other application." },
].map((challenge) => ({
  name: `auth-challenge-${challenge.kind}`,
  note: `The ${challenge.kind} challenge survives subprocess validation and gateway forwarding without losing its payload.`,
  value: {
    flowId: "fixture-flow",
    type: "challenge",
    id: `question-${challenge.kind}`,
    challenge,
    expectsAnswer: ["code", "fields", "widget"].includes(challenge.kind),
  },
}));

export const CONTRACT_MESSAGE_FIXTURES: readonly WireFixture[] = [
  {
    name: "auth-complete-extras",
    note: "Terminal auth preserves connection deadlines, notices and the retry remedy across the gateway.",
    value: {
      flowId: "fixture-flow",
      ok: true,
      accountId: "workspace:demo",
      accountIds: ["workspace:demo"],
      accountStates: {
        "workspace:demo": { status: "connected", expiresAt: "2030-01-01T00:00:00.000Z" },
      },
      notices: [{ title: "History is partial", detail: "Earlier history was not supplied." }],
      remedy: "Review the connection permissions.",
      retryAfterMs: 60000,
    },
  },
  {
    name: "sync-status-partial-warning",
    note: "A completed run retains unknown coverage and a nonfatal actionable warning instead of claiming completeness.",
    value: {
      sourceId: "fixture:workspace:demo",
      state: "completed",
      coverage: "unknown",
      progress: { phase: "incremental", processed: 40, coverage: "unknown" },
      issueAssessments: [
        { code: "snapshot-withheld", scope: "partition", subject: "Unreadable folder" },
      ],
      issues: [
        {
          code: "snapshot-withheld",
          scope: "partition",
          kind: "permission",
          count: 1,
          subject: "Unreadable folder",
          message: "Deletion detection is withheld for an unreadable folder.",
          remediation: {
            summary: "Restore folder access",
            steps: ["Check folder permissions."],
            restartRequired: false,
          },
        },
      ],
    },
  },
  {
    name: "sync-status-notices-members",
    note: "Each member of a multi-device source carries its own person-facing notices; clients render them verbatim and tolerate a kind or severity they do not know.",
    value: {
      sourceId: "fixture:workspace:demo",
      state: "completed",
      members: [
        {
          sourceId: "fixture:workspace:demo",
          deviceId: "fixture-device-a",
          state: "completed",
          notices: [
            {
              kind: "coverage-partial",
              severity: "info",
              title: "Only recent history is reachable",
              detail: "Earlier history was not supplied.",
            },
          ],
        },
        {
          sourceId: "fixture:workspace:demo",
          deviceId: "fixture-device-b",
          state: "error",
          errorMessage: "Connection refused",
          notices: [
            {
              kind: "error",
              severity: "error",
              title: "The last sync failed",
              detail: "Connection refused",
              steps: ["Check the network connection.", "Sync again."],
              since: "2030-01-01T00:00:00.000Z",
            },
            {
              kind: "replica-dispute",
              severity: "info",
              title: "Some items were restored on this device",
            },
            {
              kind: "fixture-future-kind",
              severity: "fixture-future-severity",
              title: "A notice from a newer gateway",
            },
          ],
        },
      ],
    },
  },
  {
    name: "documents-partition-claims",
    note: "A page stamps the same partition it claims, including an independently empty sibling partition.",
    value: {
      providerId: "fixture",
      sourceId: "fixture:workspace:demo",
      documents: [
        {
          providerId: "fixture",
          sourceId: "fixture:workspace:demo",
          externalId: "note-1",
          title: "Fixture note",
          content: "Fictional content",
          contentHash: "fixture-hash",
          metadata: {},
          sourceCreatedAt: "2030-01-01T00:00:00.000Z",
          sourceUpdatedAt: "2030-01-01T00:00:00.000Z",
          partitionKey: "folder:one",
        },
      ],
      presentClaims: [
        { partition: "folder:one", ids: ["note-1"] },
        { partition: "folder:two", ids: [] },
      ],
      hasMore: false,
      cursor: { offset: 12 },
    },
  },
  {
    name: "analytics-tuple-keys",
    note: "Composite deletion and presence keys retain scalar types and empty snapshots are distinguishable from omission.",
    value: {
      sourceId: "fixture:workspace:demo",
      tableName: "fixture_rows",
      records: [],
      deletedKeys: [{ group_id: "group:one", sequence: 2, active: false }],
      presentKeys: [],
    },
  },
  {
    name: "source-account-family",
    note: "Opaque colon-bearing account identity, aliases and family display metadata remain distinct during registration.",
    value: {
      cursor: {},
      account: {
        id: "workspace:demo",
        label: "Demo workspace",
        subject: { kind: "opaque", value: "workspace:demo" },
        tenant: { id: "tenant:demo", label: "Demo tenant" },
        aliases: [{ kind: "email", value: "owner@example.com" }],
      },
      family: {
        icon: "folder",
        label: "Fixture source",
        bgColor: "#112233",
        accentColor: "#445566",
      },
    },
  },
];

/** Every fixture, in the order they are written to disk. */
export const WIRE_FIXTURES: readonly WireFixture[] = [
  ...STATE_FIXTURES,
  ...FAILURE_FIXTURES,
  ...COVERAGE_FIXTURES,
  ...AUTH_CHALLENGE_FIXTURES,
  ...CONTRACT_MESSAGE_FIXTURES,
];

/** The bytes a fixture becomes on disk — stable ordering, trailing newline. */
export function renderWireFixture(fixture: WireFixture): string {
  return `${JSON.stringify(fixture.value, null, 2)}\n`;
}

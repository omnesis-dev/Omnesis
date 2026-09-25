// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sources shaped like the real ones, without the real ones.
 *
 * Proving a contract change is safe means driving it through every shape a
 * source can take: a mail account with a change token, a vault of files with a
 * fingerprint per file, a chat archive whose history lives in a local store, a
 * ledger fanning one upstream record into several tables. Reaching for the
 * actual providers to do that is the obvious move and the wrong one — it needs
 * credentials, it needs a network, it is slow, and a failure tells you a
 * provider broke without telling you which part of the contract broke it.
 *
 * These are deliberate reductions. Each keeps exactly the properties of its
 * real counterpart that the contract has to handle — the shape of the
 * bookmark, how deletion is detected, whether history can be re-read, how many
 * tables a page touches — and drops everything else. When a contract change
 * breaks one of these, the failure names the property rather than the
 * provider.
 *
 * Everything here is invented. No shape carries a real name, address, handle
 * or identifier, and none is derived from any indexed corpus.
 */

import type { SourceStateSpec } from "../source-state.js";

/**
 * One synthetic shape: a state declaration, the fixtures that prove its
 * migrations, and the properties that make it worth having.
 */
export interface SyntheticShape<S extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable id, used in test names and as the synthetic source's own id. */
  id: string;
  /** Which real shape this reduces, in one line. */
  models: string;
  /** The property under test that this shape exists to exercise. */
  exercises: string;
  /** The state declaration a source of this shape would carry. */
  state: SourceStateSpec<S>;
  /** A representative stored value per state version, inner shape (no envelope). */
  fixtures: Record<number, unknown>;
  /** Values in the pre-envelope shape an installed release actually wrote. */
  legacyFixtures?: readonly unknown[];
  /** Values this shape must refuse rather than resume from. */
  refusedFixtures?: readonly unknown[];
}

// ── A mail account with an upstream change token ────────────────────────────

export interface MailState extends Record<string, unknown> {
  phase: "bootstrap" | "incremental";
  changeToken?: string;
  pageToken?: string;
}

const isMail = (v: unknown): v is MailState =>
  typeof v === "object" &&
  v !== null &&
  ((v as MailState).phase === "bootstrap" || (v as MailState).phase === "incremental");

/**
 * The commonest shape in the tree: a phase, an opaque upstream change token,
 * and a page pointer. Upstream still holds everything, so starting over is
 * expensive but never lossy.
 */
export const mailShape: SyntheticShape<MailState> = {
  id: "synth-mail",
  models: "a hosted mailbox with a change feed",
  exercises: "a bookmark whose only cost of loss is a re-read",
  state: {
    version: 1,
    minorVersion: 1,
    decode: (v) => (isMail(v) ? v : null),
    onUnreadable: "rebootstrap",
  },
  fixtures: {
    1: { phase: "incremental", changeToken: "chg-918420", pageToken: undefined },
  },
  legacyFixtures: [
    { phase: "incremental", changeToken: "chg-901017" },
    { phase: "bootstrap", pageToken: "pg-0004" },
  ],
};

// ── A vault of files, keyed by fingerprint, with a real migration ───────────

export interface VaultState extends Record<string, unknown> {
  files: Record<string, { fingerprint: string; stableId: string }>;
  pendingRekeyDeletes?: string[];
}

const isVault = (v: unknown): v is VaultState =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as VaultState).files === "object" &&
  (v as VaultState).files !== null;

/**
 * A local folder whose documents were once keyed by path and are now keyed by
 * a stable identity. The migration has to do two things at once: forget every
 * fingerprint so each file re-emits, and stage the old path-shaped ids for
 * deletion so the corpus does not end up holding both generations.
 *
 * This is the shape that proves a migration can carry *work* forward, not just
 * a position.
 */
export const vaultShape: SyntheticShape<VaultState> = {
  id: "synth-vault",
  models: "a notes vault re-keyed from path to stable identity",
  exercises: "a migration that stages deletions, not just a resume position",
  state: {
    version: 2,
    decode: (v) => (isVault(v) ? v : null),
    // The pre-envelope cursor declared its own version.
    legacyVersion: (v) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      const c = v as { version?: unknown; files?: unknown; paths?: unknown };
      if (c.version === 2 && typeof c.files === "object") return 2;
      if (c.version === undefined && typeof c.paths === "object") return 1;
      return null;
    },
    migrate: {
      // Forget every fingerprint so each file re-emits under its new id, and
      // carry the old path-shaped ids forward so the sync can delete them.
      1: (prior) => {
        const paths = Object.keys((prior as { paths?: Record<string, unknown> }).paths ?? {});
        return {
          files: {},
          ...(paths.length > 0 ? { pendingRekeyDeletes: paths } : {}),
        };
      },
    },
    onUnreadable: "rebootstrap",
  },
  fixtures: {
    1: { paths: { "projects/orbit.md": "f1", "daily/2026-09-05.md": "f2" } },
    2: {
      files: {
        "projects/orbit.md": { fingerprint: "b7e1c0", stableId: "note-8c1f0e42" },
        "daily/2026-09-05.md": { fingerprint: "41a9de", stableId: "note-4d70e2b9" },
      },
    },
  },
  legacyFixtures: [
    { paths: { "archive/old-plan.md": "f0" } },
    // Caught mid-migration: the rekey deletions are still pending.
    {
      version: 2,
      files: { "projects/orbit.md": { fingerprint: "b7e1c0", stableId: "note-8c1f0e42" } },
      pendingRekeyDeletes: ["daily/2026-09-05.md"],
    },
  ],
  refusedFixtures: [{ version: 99, files: {} }, { somethingElse: true }],
};

// ── A chat archive whose history lives in a local store ─────────────────────

export interface ChatState extends Record<string, unknown> {
  phase: "bootstrap" | "incremental";
  committedSeq: number;
  storeId?: string;
}

const isChat = (v: unknown): v is ChatState =>
  typeof v === "object" &&
  v !== null &&
  ((v as ChatState).phase === "bootstrap" || (v as ChatState).phase === "incremental");

/**
 * A wake-on-event source whose upstream cannot be re-read: the archive lives
 * in a durable local store, and the bookmark's job is to say which of that
 * store's pending rows the host has already accepted.
 *
 * The subtlety this shape exists to hold is that losing the bookmark is
 * *cheap* here, because a floored acknowledgement clears nothing and re-emits
 * a bounded set. What is expensive is trusting a bookmark that belongs to a
 * different store — which is why the state carries the store's identity.
 */
export const chatShape: SyntheticShape<ChatState> = {
  id: "synth-chat",
  models: "a messaging archive held in a durable local store",
  exercises: "an acknowledgement position, and the danger of a foreign one",
  state: {
    version: 1,
    minorVersion: 1,
    decode: (v) => {
      if (!isChat(v)) return null;
      const c = v as ChatState;
      return {
        phase: c.phase,
        // Floored deliberately: zero clears nothing, so an absent or
        // nonsensical value costs one duplicate emission rather than data.
        committedSeq:
          typeof c.committedSeq === "number" && c.committedSeq >= 0 ? c.committedSeq : 0,
        ...(typeof c.storeId === "string" ? { storeId: c.storeId } : {}),
      };
    },
    onUnreadable: "rebootstrap",
  },
  fixtures: {
    1: { phase: "incremental", committedSeq: 412, storeId: "store-8c1f0e42" },
  },
  legacyFixtures: [
    // Predates the acknowledgement sequence entirely.
    { phase: "incremental", historySyncComplete: true },
    { phase: "bootstrap", committedSeq: 0 },
  ],
};

// ── A ledger fanning one upstream record into several tables ────────────────

export interface LedgerState extends Record<string, unknown> {
  phase: "accounts" | "balances" | "transactions";
  cursorByAccount: Record<string, string>;
}

const isLedger = (v: unknown): v is LedgerState =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as LedgerState).cursorByAccount === "object" &&
  ["accounts", "balances", "transactions"].includes(String((v as LedgerState).phase));

/**
 * One authentication yielding several accounts, each walked through a phase
 * machine that writes a different table per phase. The shape that shows why a
 * page describing one table forces a source to invent a phase dance.
 */
export const ledgerShape: SyntheticShape<LedgerState> = {
  id: "synth-ledger",
  models: "an aggregator with several accounts and several tables",
  exercises: "a multi-phase walk across tables under one bookmark",
  state: {
    version: 1,
    decode: (v) => (isLedger(v) ? v : null),
    onUnreadable: "rebootstrap",
  },
  fixtures: {
    1: {
      phase: "transactions",
      cursorByAccount: { "acct-0001": "txn-88120", "acct-0002": "txn-44019" },
    },
  },
  legacyFixtures: [{ phase: "accounts", cursorByAccount: {} }],
};

// ── A source that reads its own rows back to enrich them ────────────────────

export interface EnrichState extends Record<string, unknown> {
  sweepThrough: string;
  tier: "detail" | "splits" | "zones" | "idle";
}

const isEnrich = (v: unknown): v is EnrichState =>
  typeof v === "object" && v !== null && typeof (v as EnrichState).sweepThrough === "string";

/**
 * A source whose second pass asks which of its own stored rows still lack
 * their expensive detail, and fetches only those. The shape that justifies a
 * read facet on the host: without it the alternative is re-walking the whole
 * upstream every cycle, at one third-party call per item per cycle forever.
 */
export const enrichShape: SyntheticShape<EnrichState> = {
  id: "synth-enrich",
  models: "an activity feed enriched tier by tier from its own stored rows",
  exercises: "reading a source's own rows back, and writing child tables",
  state: {
    version: 1,
    decode: (v) => (isEnrich(v) ? v : null),
    onUnreadable: "rebootstrap",
  },
  fixtures: {
    1: { sweepThrough: "2026-09-01T18:22:31Z", tier: "splits" },
  },
  legacyFixtures: [{ sweepThrough: "2026-08-01T00:00:00Z", tier: "idle" }],
};

// ── A source whose tables are discovered at runtime ─────────────────────────

export interface DynamicState extends Record<string, unknown> {
  collections: Record<string, { cursor?: string; failures?: number }>;
}

const isDynamic = (v: unknown): v is DynamicState =>
  typeof v === "object" && v !== null && typeof (v as DynamicState).collections === "object";

/**
 * Tables whose columns the operator defines upstream and changes at will. The
 * shape that stops a schema contract from assuming compile-time knowledge of
 * every column.
 */
export const dynamicShape: SyntheticShape<DynamicState> = {
  id: "synth-dynamic",
  models: "a workspace of user-defined collections",
  exercises: "schemas discovered at runtime, and per-collection backoff",
  state: {
    version: 1,
    decode: (v) => (isDynamic(v) ? v : null),
    onUnreadable: "rebootstrap",
  },
  fixtures: {
    1: {
      collections: {
        "col-reading-list": { cursor: "row-0410" },
        "col-inventory": { failures: 2 },
      },
    },
  },
  legacyFixtures: [{ collections: {} }],
};

// ── A source with one state per contributing device ─────────────────────────

export interface PartitionedState extends Record<string, unknown> {
  throughMillis: number;
}

const isPartitioned = (v: unknown): v is PartitionedState =>
  typeof v === "object" && v !== null && typeof (v as PartitionedState).throughMillis === "number";

/**
 * A source where each device contributes different data and the corpus is
 * their union, so each device carries its own bookmark and one device's reset
 * must not disturb another's.
 */
export const partitionedShape: SyntheticShape<PartitionedState> = {
  id: "synth-partitioned",
  models: "device-local activity contributed by several phones",
  exercises: "a per-device bookmark under one logical source",
  state: {
    version: 1,
    decode: (v) => (isPartitioned(v) ? v : null),
    onUnreadable: "rebootstrap",
  },
  fixtures: { 1: { throughMillis: 1_772_150_400_000 } },
  legacyFixtures: [{ throughMillis: 0 }],
};

/**
 * Every shape, for a test that wants to assert a property across all of them.
 *
 * A contract change that holds for this list holds for every shape the tree
 * actually contains, which is the point of keeping it exhaustive rather than
 * representative.
 */
export const allSyntheticShapes: readonly SyntheticShape[] = [
  mailShape,
  vaultShape,
  chatShape,
  ledgerShape,
  enrichShape,
  dynamicShape,
  partitionedShape,
] as unknown as readonly SyntheticShape[];

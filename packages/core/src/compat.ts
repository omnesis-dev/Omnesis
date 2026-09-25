// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The compatibility manifest — one machine-readable object that answers,
 * for a given build: what product version this is, how each persisted store
 * is versioned and recovered, and which wire protocols it speaks.
 *
 * Omnesis ships a single lockstep product version (`GET /health`,
 * `omnesis --version`, the `vX.Y.Z` git tag). That number alone does not say
 * whether two builds can share a database, talk over the device socket, or
 * survive a downgrade. Those facts live in different places — `PRAGMA
 * user_version` for `omnesis.db`, `PROTOCOL_VERSION` for the device socket,
 * `PAIRING_PROTOCOL_VERSION` for QR pairing, the config schema generation —
 * and were previously only discoverable by reading code. This manifest
 * collects them so a peer, the updater, or an operator can reason about
 * compatibility before connecting or upgrading.
 *
 * The gateway exposes the full manifest on `GET /admin/compat` and a minimal
 * public subset on `GET /health`. The static parts (protocols, store
 * policies, config schema generation, the HTTP-API policy) live here in
 * `@omnesis/core`; the gateway supplies the two runtime numbers it owns
 * (`productVersion`, the main-DB schema version) via {@link buildCompatManifest}.
 */

import { CONFIG_SCHEMA_VERSION } from "@omnesis/config";
import {
  AGENT_DELIVERY_PROTOCOL_MIN_VERSION,
  AGENT_DELIVERY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./ws-messages.js";
import { PAIRING_PROTOCOL_MIN_VERSION, PAIRING_PROTOCOL_VERSION } from "./pairing-protocol.js";
import { MINIMUM_CLIENT_VERSIONS } from "./client-version.js";
import {
  PUSH_RELAY_PROTOCOL_MAX_VERSION,
  PUSH_RELAY_PROTOCOL_MIN_VERSION,
  PUSH_RELAY_PROTOCOL_VERSION,
} from "./push/enrolment.js";
import type { DeviceKind } from "@omnesis/types";

/**
 * How a persisted store is versioned, and therefore how it is upgraded and
 * recovered. Each value is a contract, not just a label:
 *
 * - `numbered-migrations` — a `PRAGMA user_version` chain replayed forward on
 *   boot; the migration list is append-only and contiguous (`omnesis.db`).
 * - `derivable` — fully rebuildable from another store, so migrations may
 *   repair or simply wipe-and-rebuild with no rollback promise (`index.db`,
 *   `index.usearch`, rebuilt from `omnesis.db`).
 * - `source-schema-evolved` — tables created and evolved online from the
 *   schemas structured sources declare at runtime; recovery is a source
 *   re-sync, not an internal job (`analytics.db`).
 * - `in-place` — zod-validated on every load; retired keys are stripped while
 *   valid neighboring values are preserved (`omnesis.json`).
 * - `provider-owned` — the shape is the source's contract; each provider
 *   validates and migrates its own cursor / local store.
 */
export type StorePolicy =
  | "numbered-migrations"
  | "derivable"
  | "source-schema-evolved"
  | "in-place"
  | "provider-owned";

export interface StoreCompat {
  readonly policy: StorePolicy;
  /**
   * The store's current schema version where it carries a numbered one
   * (`omnesis.db` main schema, the config generation); `null` for stores
   * whose policy has no single version number.
   */
  readonly version: number | null;
}

/**
 * HTTP-API compatibility policy. The surface is unversioned in the URL
 * (`versionedUrl: null`): the contract is per-route zod-at-the-boundary, and
 * the cross-version promise is conveyed here rather than by a `/v1` prefix.
 */
export interface HttpApiCompat {
  /** Within a minor release, only additive (optional / new) changes land. */
  readonly policy: "additive-within-minor";
  /** Breaking request/response changes are confined to a major bump. */
  readonly breakingOnlyOn: "major";
  /** URL version prefix, or `null` while the API is unversioned (current). */
  readonly versionedUrl: string | null;
}

export const HTTP_API_COMPAT: HttpApiCompat = {
  policy: "additive-within-minor",
  breakingOnlyOn: "major",
  versionedUrl: null,
};

export interface CompatManifest {
  /** Lockstep product version of this build (semver). */
  readonly productVersion: string;
  readonly stores: {
    /** `omnesis.db` — the document store; numbered migrations. */
    readonly mainDb: StoreCompat;
    /** `index.db` + `index.usearch` — derivable from `omnesis.db`. */
    readonly indexDb: StoreCompat;
    /** `analytics.db` — DuckDB; per-source online schema evolution. */
    readonly analyticsDb: StoreCompat;
    /** `omnesis.json` — zod-validated config with backward-load stripping. */
    readonly config: StoreCompat;
    /** Per-source sync cursors and provider-local stores. */
    readonly cursors: StoreCompat;
  };
  readonly protocols: {
    /** Device WebSocket protocol — exact-match gate (lockstep). */
    readonly ws: number;
    /** QR pairing payload version — decoder accepts a back-compat range. */
    readonly pairing: number;
    /** QR pairing payload versions decoded by this build. */
    readonly pairingAccepted: {
      readonly min: number;
      readonly max: number;
    };
    /** Hosted push-relay wire protocol and the versions this build accepts. */
    readonly pushRelay: {
      readonly current: number;
      readonly min: number;
      readonly max: number;
    };
    /**
     * The wake protocol spoken to an external agent integration.
     *
     * A range rather than a lockstep number because the two halves are
     * deployed apart: a harness host runs a plugin somebody installed once,
     * and the gateway builds each wake at the highest version that plugin says
     * it understands. This is what makes "which of the pair is too old" an
     * answerable question rather than a reconnect loop.
     */
    readonly agentDelivery: {
      readonly current: number;
      readonly min: number;
      readonly max: number;
    };
  };
  readonly httpApi: HttpApiCompat;
  readonly clients: ClientCompat;
}

/**
 * What this gateway asks of the clients paired to it.
 *
 * The floor is per kind because the kinds do not travel together: a
 * collector or CLI is updated on a host the operator controls, while an iOS,
 * Android or browser build reaches its device through a store queue and so
 * legitimately trails the tag it was cut from. One global floor would
 * therefore either be too lax for the hosts or too strict for the apps.
 */
export interface ClientCompat {
  /** Oldest supported product version per device kind (semver). */
  readonly minimumVersions: Readonly<Record<DeviceKind, string>>;
}

/**
 * Assemble the manifest from the static `@omnesis/core` facts plus the two
 * runtime numbers the gateway owns: its product version and the main-DB
 * schema head (`LATEST_SCHEMA_VERSION`). Keeping this a builder — rather than
 * a frozen constant — is what lets the gateway feed in
 * `data/migrations.ts`'s `LATEST_SCHEMA_VERSION` without `@omnesis/core`
 * having to depend on `@omnesis/gateway`.
 */
export function buildCompatManifest(args: {
  productVersion: string;
  mainDbSchemaVersion: number;
}): CompatManifest {
  return {
    productVersion: args.productVersion,
    stores: {
      mainDb: { policy: "numbered-migrations", version: args.mainDbSchemaVersion },
      indexDb: { policy: "derivable", version: null },
      analyticsDb: { policy: "source-schema-evolved", version: null },
      config: { policy: "in-place", version: CONFIG_SCHEMA_VERSION },
      cursors: { policy: "provider-owned", version: null },
    },
    protocols: {
      ws: PROTOCOL_VERSION,
      pairing: PAIRING_PROTOCOL_VERSION,
      pairingAccepted: {
        min: PAIRING_PROTOCOL_MIN_VERSION,
        max: PAIRING_PROTOCOL_VERSION,
      },
      pushRelay: {
        current: PUSH_RELAY_PROTOCOL_VERSION,
        min: PUSH_RELAY_PROTOCOL_MIN_VERSION,
        max: PUSH_RELAY_PROTOCOL_MAX_VERSION,
      },
      agentDelivery: {
        current: AGENT_DELIVERY_PROTOCOL_VERSION,
        min: AGENT_DELIVERY_PROTOCOL_MIN_VERSION,
        max: AGENT_DELIVERY_PROTOCOL_VERSION,
      },
    },
    httpApi: HTTP_API_COMPAT,
    clients: { minimumVersions: MINIMUM_CLIENT_VERSIONS },
  };
}

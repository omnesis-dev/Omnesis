// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared types for the sync-engine subsystem. Lifted out of
 * `sync-engine.ts` so the new collaborators (`SourceRegistry`,
 * `SyncDispatcher`) can depend on them without a circular import on
 * the engine façade. Same role as `scheduler/internals.ts` in the
 * gateway's `scheduler-class-split` (PR #364).
 */

import { parseSourceKey } from "@omnesis/core";
import type { UrlCanonicalizerSpec } from "@omnesis/core";
import type {
  DocumentTemporalProjectionSpec,
  SourceIcon,
  SourceInstance,
  SelfIdentitySpec,
  ConnectionState,
  AccountDescriptor,
} from "@omnesis/source-sdk";
import type { ProviderId, SourceId, MultiDeviceMode } from "@omnesis/types";
import type { SourceStatus } from "./source-lifecycle.js";

/**
 * Prefix for credential-failure error messages reported back to the
 * gateway. Keep in sync with `NEEDS_AUTH_ERROR_PREFIX` on the gateway —
 * `deriveDisplayStatus` uses it to map persisted errors back to
 * `needs-auth` after a gateway restart wipes in-memory state.
 */
export const NEEDS_AUTH_ERROR_PREFIX = "needs reauth: ";

/**
 * Prefix for rate-limit deferral messages reported back to the gateway.
 * Keep in sync with `RATE_LIMITED_ERROR_PREFIX` on the gateway —
 * `deriveDisplayStatus` uses it to map a persisted error back to the
 * `rate-limited` pill (instead of a generic red `error`) after a gateway
 * restart wipes in-memory state.
 */
export const RATE_LIMITED_ERROR_PREFIX = "rate-limited: ";

/**
 * Build a human-friendly back-off note for a source the provider asked us
 * to defer. The retry-after window is formatted coarsely (`~6h`, `~60s`)
 * so the operator sees roughly when the source will retry without parsing
 * milliseconds. The provider's own message (the `SyncError.message`) is
 * appended so the upstream cause stays visible.
 */
export function buildRateLimitedHint(retryAfterMs: number, providerMessage?: string): string {
  const secs = Math.round(retryAfterMs / 1000);
  const window =
    secs >= 3600
      ? `~${Math.round(secs / 3600)}h`
      : secs >= 60
        ? `~${Math.round(secs / 60)}m`
        : `~${secs}s`;
  const tail = providerMessage ? ` — ${providerMessage}` : "";
  return `${RATE_LIMITED_ERROR_PREFIX}rate limited; retrying in ${window}${tail}`;
}

/**
 * Build a human-friendly remediation hint for a source whose credentials
 * have gone bad. Recommends `cli sources reauth <provider-id>` — a single
 * OAuth pass refreshes every source under the provider+account (gmail +
 * calendar + contacts + drive all share the same tokens), so the verb is
 * provider-scoped on purpose. We fall back to `cli sources reauth
 * <source-type>` when the providerId is unknown — the CLI accepts both
 * forms.
 */
export function buildReauthHint(sourceId: string, providerId?: string): string {
  // Prefer the provider-id form (`google:user@gmail.com`) when we have it.
  // Falls back to source-type when called from a code path that hasn't
  // wired providerId through yet.
  const target =
    providerId && providerId.length > 0 ? providerId : parseSourceKey(sourceId).sourceType;
  return `${NEEDS_AUTH_ERROR_PREFIX}run \`cli -- sources reauth ${target}\` to re-authenticate`;
}

/** A registered source combining definition metadata with a live instance. */
export interface RegisteredSource {
  id: SourceId;
  account?: AccountDescriptor;
  name: string;
  providerId: ProviderId;
  /**
   * The source's multi-device mode from its definition. A handoff or
   * replicated source is synced under the gateway's sync lease.
   */
  multiDeviceMode?: MultiDeviceMode;
  icon?: SourceIcon;
  /**
   * The identity of the source's family — the definition-level name and icon,
   * before any per-instance override.
   *
   * `name` and `icon` above are this source's own, which for an accounted
   * source is whatever its instance chose. Clients that display a source by
   * type rather than by id need the family's, and it cannot be recovered by
   * picking one account's: two accounts of one type legitimately differ, so
   * copying either names a family after one of its members.
   */
  family: { name: string; icon?: SourceIcon };
  urlPatterns?: Array<{ regex: string; idGroup?: number }>;
  /**
   * Per-host URL canonicalizer copied from the source's
   * `defineSource`. The collector pushes the union of these to the
   * gateway at startup so the gateway can canonicalize URLs at ingest
   * + lookup without holding source-specific knowledge itself.
   */
  urlCanonicalizer?: UrlCanonicalizerSpec;
  /**
   * Default additive search-score prior copied from the source's
   * `defineSource`. The collector pushes the union of these to the
   * gateway at startup so the search pipeline can apply per-source
   * defaults the user can still override in `omnesis.json`.
   */
  defaultSourcePrior?: number;
  /**
   * URL-hub flag copied from the source's `defineSource`. The
   * collector pushes the union of these to the gateway at startup so
   * the graph subgraph walker can drop `url`-typed edges through
   * hub-source documents without holding source-specific knowledge
   * itself.
   */
  urlHub?: boolean;
  /**
   * URL representation role copied from `defineSource`. A fallback document
   * yields inbound URL ownership to a non-fallback claimant of the same
   * canonical URL while remaining connected via `same-resource`.
   */
  urlTargetRole?: "fallback" | "reference";
  /**
   * Conversation flag copied from the source's `defineSource`. Marks a
   * source whose audio is transcribed inline into the message stream
   * rather than emitted as attachment child-docs. Mirrors the descriptor
   * field so shared code routes audio by this rather than by source name.
   */
  conversational?: boolean;
  /**
   * Self-identity hook copied from the source's `defineSource`. The collector
   * pushes the union of these to the gateway at startup so the self-detection
   * pass can pair a synced source account to the self LID alias the source
   * emits, without holding source-specific knowledge gateway-side.
   */
  selfIdentity?: SelfIdentitySpec;
  unitName?: string;
  instance: SourceInstance;
  /**
   * Push-based sources are driven by an external collector (e.g. the iOS app
   * pushing Apple Health data). They still appear in the registry and status
   * UI but the engine must NEVER schedule sync timers or invoke `sync()` /
   * `syncStructured()` on their instance — there is no source-side sync
   * logic on the Mac side.
   */
  pushBased?: boolean;
  /** See `SourceDescriptor.contentRetention`. */
  contentRetention?: "complete" | "best-effort";
  /** Source-owned typed document projection contracts forwarded on each page. */
  documentTemporalProjections?: DocumentTemporalProjectionSpec[];
}

/** A registered provider grouping sources under shared auth. */
export interface RegisteredProvider {
  id: ProviderId;
  name: string;
  /**
   * What state this account's credential is in, read before each sync round.
   *
   * A state rather than a bit, because the interesting cases are the ones a
   * bit cannot carry: a grant with a known deadline is still usable, a grant
   * that is merely too narrow should keep syncing what it can reach, and a
   * credential that could not be read is not a credential that is absent.
   */
  credentialState: () => Promise<ConnectionState>;
  /**
   * Whether this account holds a credential an operator could renew.
   *
   * False for a source that reads a local store: there is nothing to
   * re-authorize, so parking it as `needs-auth` would offer a remedy that does
   * not exist. Such a source still reports a state — an unreadable database is
   * worth saying — it simply is never stopped by one, and reports its real
   * problem from the sync path where the concrete local error is.
   */
  renewableCredential: boolean;
  sources: RegisteredSource[];
}

export type StatusChangeEvent =
  | { event: "sync.started"; sourceId: string; status: SourceStatus }
  | { event: "sync.progress"; sourceId: string; status: SourceStatus }
  | { event: "sync.deferred"; sourceId: string; status: SourceStatus }
  /** A run stopped for a restart has released its claim; the fresh run reports its own start. */
  | { event: "sync.aborted"; sourceId: string; status: SourceStatus }
  | { event: "sync.completed"; sourceId: string; status: SourceStatus }
  | { event: "sync.error"; sourceId: string; status: SourceStatus };

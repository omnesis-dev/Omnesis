// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Building the services a source is lent.
 *
 * The shape is declared in `@omnesis/source-sdk` (`source-host.ts`); this is
 * the collector's implementation of it. Kept apart from the instantiator
 * because it is the one place the collector decides what a source may reach,
 * and that decision is worth being able to read on its own.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";
import { safePathSegment } from "@omnesis/types";
import type { DocumentIngestionContext } from "@omnesis/types";
import type { AttachmentExtractFn, AudioTranscribeFn } from "@omnesis/core";
import type {
  GatewayClient,
  ProviderHost,
  SourceAnalyticsAccess,
  SourceHost,
} from "@omnesis/source-sdk";

export interface HostInputs {
  /** Provider base id, e.g. `google` — not the account-suffixed provider id. */
  providerBaseId: string;
  /** The account this instance belongs to. */
  accountId: string;
  /** The collector's configuration root. */
  configDir: string;
  ingestionContext?: DocumentIngestionContext;
  extractAttachment?: AttachmentExtractFn;
}

/**
 * The directory a provider's account owns.
 *
 * Deliberately the layout that already exists on disk — `<configDir>/<provider>/
 * <account>` — rather than a new one. Sources keep their credentials and local
 * stores exactly where they are, and what changes is only that they are handed
 * the path instead of re-deriving it.
 */
export function accountStateDir(input: {
  providerBaseId: string;
  accountId: string;
  configDir: string;
}): string {
  return join(
    input.configDir,
    safePathSegment(input.providerBaseId),
    safePathSegment(input.accountId),
  );
}

/** Account-scoped services, for a provider's shared context. */
export function buildProviderHost(input: HostInputs): ProviderHost {
  const stateDir = accountStateDir(input);
  return {
    log: createLogger(`provider:${input.providerBaseId}`),
    now: () => new Date(),
    stateDir,
    configDir: input.configDir,
    ingestion: input.ingestionContext,
    extractAttachment: input.extractAttachment,
  };
}

/**
 * Source-scoped services.
 *
 * `analytics` is present only for a source that declares tables. A
 * documents-only source has none, so handing it a query facet would be the
 * same over-provisioning at a smaller scale.
 *
 * The state directory is created here rather than lazily, so a source can join
 * a filename to it and write immediately. Creating it is idempotent and
 * costs one syscall per instantiation.
 */
export function buildSourceHost(
  input: HostInputs & {
    sourceId: string;
    sourceType: string;
    /**
     * Audio routing, decided per source by whether it is conversational. Not
     * on the account-scoped inputs: a provider context has no source to route
     * for, and supplying a default there would hand it a value that is always
     * wrong for one of the two cases.
     */
    transcribeAudio?: AudioTranscribeFn;
    includeAudioTypes?: boolean;
    /** The gateway client, when this source declares analytics tables. */
    gateway?: GatewayClient;
    declaresAnalytics: boolean;
  },
): SourceHost {
  const base = buildProviderHost(input);
  try {
    mkdirSync(base.stateDir, { recursive: true });
  } catch (err) {
    // A source that does not keep a local store does not care, and one that
    // does will fail with its own, more specific message when it writes.
    // Refusing to instantiate here would take down sources that never touch it.
    base.log.debug(
      `Could not pre-create ${base.stateDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    ...base,
    log: createLogger(`source:${input.sourceType}`),
    transcribeAudio: input.transcribeAudio,
    includeAudioTypes: input.includeAudioTypes ?? false,
    analytics:
      input.declaresAnalytics && input.gateway
        ? scopedAnalytics(input.gateway, input.sourceId)
        : undefined,
  };
}

/**
 * Analytics access narrowed to one source.
 *
 * The gateway client this wraps can search every document in the install and
 * delete every document of a provider. What a source gets instead is a single
 * read, against the tables it declared and no others.
 *
 * The source id is supplied here rather than by the caller, and the gateway
 * resolves the tables from it, so a source holding this handle has no way to
 * name a scope other than its own — all it can hand over is SQL.
 *
 * Writing is not offered. A source writes through its sync page, which the
 * runner commits under the write epoch and the sync lease and covers with the
 * cursor that follows it — none of which a call from inside a source could
 * participate in.
 */
function scopedAnalytics(gateway: GatewayClient, sourceId: string): SourceAnalyticsAccess {
  return {
    query: (sql: string, opts?: { limit?: number }) =>
      gateway.queryAnalytics(sql, opts?.limit, sourceId),
  };
}

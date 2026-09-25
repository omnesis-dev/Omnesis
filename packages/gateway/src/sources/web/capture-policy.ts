// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { createLogger, hostIsOwned } from "@omnesis/core";
import { SourceId, type DeviceId, type Scope } from "@omnesis/types";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  EMPTY_WEB_CAPTURE_SETTINGS,
  MAX_CAPTURE_DOMAIN_CHARS,
  REMOVED_PAGES_RESPONSE_CAP,
  normalizeCaptureDomain,
  pauseActive,
  type WebCapturePolicy,
  type WebCaptureSettings,
} from "@omnesis/provider-web/capture-policy";
import { getSource } from "../../data/repositories/SourceRepository.js";
import { BadRequestError, ConflictError } from "../../http/errors.js";
import { WEB_PROVIDER_ID, WEB_SOURCE_ID } from "../../web-dataset.js";
import type { DocumentService } from "../../http/services/DocumentService.js";
import type { SourceService } from "../../http/services/SourceService.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway").child("web-capture-policy");

/**
 * The gateway-owned capture policy of the Web Pages source.
 *
 * The operator-editable settings — the shared pause and the excluded domains —
 * live under `capture` in the web source's own `sources.config` row, so they
 * survive with the source and every paired browser reads the same values. The
 * rest of the policy is derived on read: the hosts other sources own (pushed by
 * the collector), the built-in privacy rules, and the pages the user deleted
 * for good (the source's `removed_documents` tombstones).
 *
 * Edits are read-modify-write of one JSON column, so they run one at a time
 * through an in-process lane: two browsers adding different domains in the same
 * instant both land. The gateway is a single process, so the lane is enough.
 */

const WEB_SOURCE = SourceId(WEB_SOURCE_ID);

/** Bound on the exclusion list, so a browser token cannot grow the source row without limit. */
const MAX_EXCLUDED_DOMAINS = 1_000;

/** The `capture` block as stored on the source row. */
const storedSettingsSchema = z.object({
  pause: z.object({ until: z.number().finite().nullable() }).nullable().default(null),
  excludedDomains: z.array(z.string().max(MAX_CAPTURE_DOMAIN_CHARS)).default([]),
  updatedAt: z.string().default(""),
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;

export interface WebCapturePolicyDeps {
  db: Db;
  writeGate: WriteGate;
  sourceService: SourceService;
  documentService: DocumentService;
  /** The union of every source's `ownedWebDomains`, as the collector last pushed it. */
  ownedDomains: () => readonly string[];
  /**
   * Invalidates cached source listings after the source row changed. No
   * `source.updated` command is sent: no collector hosts the web source, and
   * browsers read the policy over HTTP.
   */
  onChanged?: () => void;
  now?: () => number;
}

interface PolicyAuth {
  deviceId?: DeviceId | null;
  scopes: readonly Scope[];
}

export class WebCapturePolicyService {
  /** The edit lane: every read-modify-write of the settings waits for the previous one. */
  private editLane: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WebCapturePolicyDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The policy every paired browser enforces. */
  read(): WebCapturePolicy {
    const stored = this.storedSettings();
    const removed = this.removedPages();
    return {
      updatedAt: stored.updatedAt,
      // A lapsed timed pause reads as resumed so clients need no clock of their own.
      pause: pauseActive(stored.pause, this.now()) ? stored.pause : null,
      excludedDomains: stored.excludedDomains,
      ownedDomains: [...this.deps.ownedDomains()],
      rules: DEFAULT_WEB_CAPTURE_RULES,
      removedPages: removed.ids,
      removedPagesTruncated: removed.truncated,
    };
  }

  /**
   * Exclude a domain (and its subdomains) everywhere. With `purge`, every page
   * already captured from it is deleted for good as well.
   */
  async addExcludedDomain(
    input: string,
    auth: PolicyAuth,
    purge: boolean,
  ): Promise<{ policy: WebCapturePolicy; purged: number }> {
    const domain = normalizeCaptureDomain(input);
    if (!domain) throw new BadRequestError("Not a valid domain");
    await this.edit(auth, (stored) => {
      if (stored.excludedDomains.includes(domain)) return null;
      if (stored.excludedDomains.length >= MAX_EXCLUDED_DOMAINS) {
        throw new BadRequestError(`At most ${MAX_EXCLUDED_DOMAINS} domains can be excluded`);
      }
      return { ...stored, excludedDomains: [...stored.excludedDomains, domain].sort() };
    });
    const purged = purge ? await this.purgeDomain(domain) : 0;
    return { policy: this.read(), purged };
  }

  async removeExcludedDomain(input: string, auth: PolicyAuth): Promise<WebCapturePolicy> {
    const domain = normalizeCaptureDomain(input);
    if (!domain) throw new BadRequestError("Not a valid domain");
    await this.edit(auth, (stored) => {
      const excludedDomains = stored.excludedDomains.filter((entry) => entry !== domain);
      return excludedDomains.length === stored.excludedDomains.length
        ? null
        : { ...stored, excludedDomains };
    });
    return this.read();
  }

  /** Pause capture in every browser until `until` (epoch-ms), or until resumed when null. */
  async setPause(until: number | null, auth: PolicyAuth): Promise<WebCapturePolicy> {
    if (until !== null && until <= this.now()) {
      throw new BadRequestError("The pause deadline is already in the past");
    }
    await this.edit(auth, (stored) => ({ ...stored, pause: { until } }));
    return this.read();
  }

  async clearPause(auth: PolicyAuth): Promise<WebCapturePolicy> {
    await this.edit(auth, (stored) => (stored.pause === null ? null : { ...stored, pause: null }));
    return this.read();
  }

  private storedSettings(): StoredSettings {
    const config = getSource(this.deps.db, WEB_SOURCE)?.config;
    const parsed = storedSettingsSchema.safeParse(config?.capture ?? {});
    if (!parsed.success) {
      log.warn(`Ignoring a malformed capture block on the web source: ${parsed.error.message}`);
      return { ...EMPTY_WEB_CAPTURE_SETTINGS, updatedAt: "" };
    }
    return parsed.data;
  }

  /**
   * Apply one change to the stored settings on the edit lane. `patch` reads the
   * settings as they are inside the lane and returns the next settings, or null
   * when nothing needs writing.
   */
  private edit(
    auth: PolicyAuth,
    patch: (stored: StoredSettings) => WebCaptureSettings | null,
  ): Promise<void> {
    const run = this.editLane.then(async () => {
      const next = patch(this.storedSettings());
      if (next) await this.write(next, auth);
    });
    this.editLane = run.catch(() => undefined);
    return run;
  }

  /**
   * Persist the settings on the web source row. A browser's first policy edit
   * may precede its first capture, so the row is registered on demand the
   * same way a first ingest registers it; an operator identity cannot register
   * it, so its edit needs a browser to have paired first.
   */
  private async write(settings: WebCaptureSettings, auth: PolicyAuth): Promise<void> {
    await this.deps.sourceService.ensurePushSourcesRegistered([WEB_SOURCE_ID], auth);
    const existing = getSource(this.deps.db, WEB_SOURCE);
    if (!existing) {
      throw new ConflictError("Pair a browser before changing its capture settings");
    }
    const capture: StoredSettings = {
      pause: settings.pause,
      excludedDomains: settings.excludedDomains,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const updated = await this.deps.writeGate.updateSource(WEB_SOURCE, {
      config: { ...existing.config, capture },
    });
    if (!updated) throw new ConflictError("The Web Pages source is changing; retry shortly");
    this.deps.onChanged?.();
  }

  /**
   * The source's privacy-delete tombstones. The web source has one stream —
   * it is never partitioned — so its tombstones all carry the empty stream id.
   */
  private removedPages(): { ids: string[]; truncated: boolean } {
    const rows = this.deps.db
      .prepare<[string, string, number], { external_id: string }>(
        `SELECT external_id FROM removed_documents
          WHERE provider_id = ? AND source_id = ? AND stream_id = ''
          ORDER BY removed_at DESC LIMIT ?`,
      )
      .all(WEB_PROVIDER_ID, WEB_SOURCE_ID, REMOVED_PAGES_RESPONSE_CAP + 1);
    const truncated = rows.length > REMOVED_PAGES_RESPONSE_CAP;
    return {
      ids: rows.slice(0, REMOVED_PAGES_RESPONSE_CAP).map((row) => row.external_id),
      truncated,
    };
  }

  /**
   * Delete for good every web page captured from `domain` or a subdomain. The
   * `instr` prefilter narrows the scan on this handle; the host check decides,
   * so a page whose path merely mentions the domain is left alone.
   */
  private async purgeDomain(domain: string): Promise<number> {
    const candidates = this.deps.db
      .prepare<
        [string, string, string],
        { external_id: string; stream_id: string; source_url: string }
      >(
        `SELECT external_id, stream_id, source_url FROM documents
          WHERE provider_id = ? AND source_id = ? AND source_url IS NOT NULL
            AND instr(source_url, ?) > 0`,
      )
      .all(WEB_PROVIDER_ID, WEB_SOURCE_ID, domain);
    const keys = candidates.filter((row) => {
      try {
        return hostIsOwned(new URL(row.source_url).hostname, [domain]);
      } catch {
        return false;
      }
    });
    const result = await this.deps.documentService.deleteDocumentsForUser(
      WEB_PROVIDER_ID,
      WEB_SOURCE_ID,
      keys.map((row) => ({ externalId: row.external_id, streamId: row.stream_id })),
      { tombstone: true },
    );
    return result.documents;
  }
}

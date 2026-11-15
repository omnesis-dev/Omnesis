// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, X509Certificate } from "node:crypto";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import {
  CertificateMonitorFailure,
  type CertificateIssuanceProvider,
  type CertificateMonitorError,
} from "./certificate-monitor-certspotter.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const identifier = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/);
const incidentSchema = z
  .object({
    hostname: z.string().max(253),
    certificateFingerprint: digest,
    spkiFingerprint: digest,
    issuer: z.string().max(256),
    serial: z.string().max(256),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime(),
    providerEntryId: identifier,
    observedAt: z.string().datetime(),
  })
  .strict();
export type CertificateIncident = z.infer<typeof incidentSchema>;
const journalSchema = z
  .object({
    version: z.literal(1),
    hostname: z.string().max(253),
    cursor: identifier.optional(),
    lastCompletedAt: timestamp.optional(),
    incidents: z.array(incidentSchema).max(32),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
export interface CertificateMonitorStatus {
  provider: "certspotter";
  hostname: string;
  state: "pending" | "observing" | "incident" | "stale" | "unavailable";
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  lastError?: CertificateMonitorError;
  nextCheckAt?: string;
  incidents: CertificateIncident[];
}
export interface CertificateMonitorOptions {
  hostname: string;
  expectedSpkiFingerprint(): string | undefined;
  journalFile: string;
  provider: CertificateIssuanceProvider;
  /**
   * Told about each certificate the journal is about to record for the first time, before the
   * journal records it. If it throws, nothing is recorded and the next check reports it again.
   */
  onIncident?(incidents: CertificateIncident[]): Promise<void>;
  now?: () => number;
}

/**
 * CT evidence. It never alters TLS pins, routing credentials or device grants itself; what a new
 * incident causes is up to `onIncident`.
 */
export class CertificateIssuanceMonitor {
  private journal: Journal;
  private incidents: CertificateIncident[] = [];
  private error: CertificateMonitorError | undefined;
  private journalInvalid = false;
  private attempt: number | undefined;
  private nextAllowed = 0;
  private pending: Promise<CertificateMonitorStatus> | undefined;
  private readonly now: () => number;
  private constructor(private readonly options: CertificateMonitorOptions) {
    this.options = Object.freeze({ ...options });
    if (
      options.hostname.length > 253 ||
      bindingOrigin(`https://${options.hostname}`).hostname !== options.hostname
    )
      throw new Error("Invalid certificate monitoring hostname");
    this.now = options.now ?? Date.now;
    this.journal = { version: 1, hostname: options.hostname, incidents: [] };
  }
  static async open(options: CertificateMonitorOptions): Promise<CertificateIssuanceMonitor> {
    const monitor = new CertificateIssuanceMonitor(options);
    try {
      const stored = journalSchema.parse(await readPrivateJson(options.journalFile));
      // A journal kept for a previous public name says nothing about this one: start afresh.
      if (stored.hostname !== options.hostname) return monitor;
      if (
        stored.incidents.some((item) => item.hostname !== options.hostname) ||
        (stored.lastCompletedAt !== undefined && stored.lastCompletedAt > monitor.now())
      )
        throw new Error();
      monitor.journal = stored;
      monitor.incidents = stored.incidents;
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        monitor.journalInvalid = true;
        monitor.error = "ct-journal-invalid";
      }
    }
    return monitor;
  }
  status(): CertificateMonitorStatus {
    const completed = this.journal.lastCompletedAt;
    const state = this.error
      ? this.error === "ct-scan-incomplete"
        ? "stale"
        : "unavailable"
      : !this.options.expectedSpkiFingerprint() || completed === undefined
        ? "pending"
        : this.now() - completed > 7_200_000
          ? "stale"
          : this.incidents.length
            ? "incident"
            : "observing";
    return {
      provider: "certspotter",
      hostname: this.options.hostname,
      state,
      lastError: this.error,
      lastAttemptAt: this.attempt === undefined ? undefined : new Date(this.attempt).toISOString(),
      lastCompletedAt: completed === undefined ? undefined : new Date(completed).toISOString(),
      nextCheckAt: this.nextAllowed ? new Date(this.nextAllowed).toISOString() : undefined,
      incidents: this.incidents.map((item) => ({ ...item })),
    };
  }
  check(signal?: AbortSignal): Promise<CertificateMonitorStatus> {
    if (this.pending) return this.pending;
    this.pending = this.inspect(signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async persist(cursor: string | undefined, completed?: number): Promise<void> {
    const next: Journal = {
      version: 1,
      hostname: this.options.hostname,
      cursor,
      lastCompletedAt: completed,
      incidents: [...this.incidents],
    };
    // All non-incident fields are bounded below 1KiB. Each iteration removes one retained record.
    while (Buffer.byteLength(JSON.stringify(next)) + 1 > 65536 && next.incidents.length)
      next.incidents.shift();
    const recorded = new Set(this.journal.incidents.map((item) => item.certificateFingerprint));
    const fresh = this.incidents.filter((item) => !recorded.has(item.certificateFingerprint));
    // Before the journal records them: a crash in between reports them again, never loses them.
    if (fresh.length && this.options.onIncident)
      try {
        await this.options.onIncident(fresh.map((item) => ({ ...item })));
      } catch {
        throw new CertificateMonitorFailure("ct-journal-write-failed");
      }
    try {
      await savePrivateJson(this.options.journalFile, next);
    } catch {
      throw new CertificateMonitorFailure("ct-journal-write-failed");
    }
    this.incidents = next.incidents;
    this.journal = next;
  }
  private async inspect(caller?: AbortSignal): Promise<CertificateMonitorStatus> {
    if (this.journalInvalid || this.now() < this.nextAllowed) return this.status();
    const baseline = this.options.expectedSpkiFingerprint();
    if (baseline === undefined) return this.status();
    const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(15_000)]);
    this.attempt = this.now();
    try {
      digest.parse(baseline);
      signal.throwIfAborted();
      let cursor = this.journal.cursor;
      const seen = new Set(cursor ? [cursor] : []);
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = await this.options.provider.page(this.options.hostname, cursor, signal);
        signal.throwIfAborted();
        let invalid = page.invalidEntries;
        for (const observation of page.entries) {
          try {
            const cert = new X509Certificate(observation.certificateDer);
            if (
              !cert.raw.equals(observation.certificateDer) ||
              !cert.checkHost(this.options.hostname, { subject: "never" })
            )
              throw new Error();
            const spkiFingerprint = createHash("sha256")
              .update(cert.publicKey.export({ type: "spki", format: "der" }))
              .digest("hex");
            const incident = incidentSchema.parse({
              hostname: this.options.hostname,
              certificateFingerprint: createHash("sha256").update(cert.raw).digest("hex"),
              spkiFingerprint,
              issuer: cert.issuer.replace(/[^\x20-\x7e]/g, "?").slice(0, 256),
              serial: cert.serialNumber,
              validFrom: new Date(cert.validFrom).toISOString(),
              validTo: new Date(cert.validTo).toISOString(),
              providerEntryId: observation.entryId,
              observedAt: new Date(this.now()).toISOString(),
            });
            if (
              spkiFingerprint !== baseline &&
              !this.incidents.some(
                (prior) => prior.certificateFingerprint === incident.certificateFingerprint,
              )
            )
              this.incidents = [...this.incidents, incident].slice(-32);
          } catch {
            invalid++;
          }
        }
        if (invalid) {
          await this.persist(cursor, this.journal.lastCompletedAt);
          throw new CertificateMonitorFailure("ct-provider-invalid");
        }
        if (page.complete) {
          if (page.entries.length) throw new CertificateMonitorFailure("ct-provider-invalid");
          signal.throwIfAborted();
          await this.persist(cursor, this.now());
          this.error = undefined;
          this.nextAllowed = page.retryAfterMs === undefined ? 0 : this.now() + page.retryAfterMs;
          return this.status();
        }
        if (
          page.lastId === undefined ||
          !identifier.safeParse(page.lastId).success ||
          seen.has(page.lastId)
        )
          throw new CertificateMonitorFailure("ct-provider-invalid");
        seen.add(page.lastId);
        cursor = page.lastId;
        signal.throwIfAborted();
        await this.persist(cursor, this.journal.lastCompletedAt);
      }
      throw new CertificateMonitorFailure("ct-scan-incomplete");
    } catch (error) {
      this.error =
        error instanceof CertificateMonitorFailure ? error.code : "ct-provider-unavailable";
      if (error instanceof CertificateMonitorFailure && error.retryAfterMs !== undefined)
        this.nextAllowed = this.now() + error.retryAfterMs;
      return this.status();
    }
  }
}

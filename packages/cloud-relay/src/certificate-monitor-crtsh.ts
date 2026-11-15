// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import {
  CertificateMonitorFailure,
  type CertificateObservation,
} from "./certificate-monitor-certspotter.js";

/**
 * A second, independent Certificate Transparency source, asked only when the first can't answer.
 * It has no cursor, so each answer is the whole history for the name.
 */
export interface CertificateSnapshotProvider {
  /**
   * Every logged certificate for the name, and for the wildcard one label up that would also cover
   * it. A list it can't give whole is a failure, never a shorter list.
   */
  snapshot(hostname: string, signal: AbortSignal): Promise<CertificateObservation[]>;
}

const MAX_ROWS = 256;
/** Certificates fetched in one scan; the rest come on the next, from where this one stopped. */
const MAX_FETCHES = 32;
const row = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/**
 * crt.sh (Sectigo's public CT search): `?q=<name>&output=json&deduplicate=Y` lists the logged
 * certificates for exactly that name (a precertificate and its certificate count once), and
 * `?d=<id>` returns one as PEM. It needs no account. It is slow and sometimes overloaded, so this is
 * the fallback, and the certificates already read are kept in memory: a certificate's content never
 * changes for its id.
 */
export class CrtShProvider implements CertificateSnapshotProvider {
  private readonly certificates = new Map<number, Buffer>();
  constructor(
    private readonly options: {
      fetch?: typeof fetch;
      /** Another service with the same API, such as a test fixture. */
      baseUrl?: string;
    } = {},
  ) {}

  async snapshot(hostname: string, signal: AbortSignal): Promise<CertificateObservation[]> {
    try {
      signal.throwIfAborted();
      if (hostname.length > 253 || bindingOrigin(`https://${hostname}`).hostname !== hostname)
        throw new Error();
      const labels = hostname.split(".");
      const names = [hostname, ...(labels.length > 2 ? [`*.${labels.slice(1).join(".")}`] : [])];
      const ids = new Set<number>();
      for (const name of names) {
        const url = this.url();
        url.search = new URLSearchParams({ q: name, output: "json", deduplicate: "Y" }).toString();
        const body = await this.read(url, 1_048_576, signal);
        let rows: unknown;
        try {
          rows = JSON.parse(body.toString("utf8"));
        } catch {
          throw new CertificateMonitorFailure("ct-provider-invalid");
        }
        if (!Array.isArray(rows)) throw new CertificateMonitorFailure("ct-provider-invalid");
        if (rows.length > MAX_ROWS) throw new CertificateMonitorFailure("ct-scan-incomplete");
        for (const value of rows) {
          const parsed = row.safeParse(value);
          if (!parsed.success) throw new CertificateMonitorFailure("ct-provider-invalid");
          ids.add(parsed.data.id);
        }
      }
      // Only what the name still lists is kept, so the cache stays as small as the list.
      for (const id of [...this.certificates.keys()])
        if (!ids.has(id)) this.certificates.delete(id);
      const entries: CertificateObservation[] = [];
      let fetched = 0;
      for (const id of [...ids].sort((a, b) => a - b)) {
        let certificateDer = this.certificates.get(id);
        if (!certificateDer) {
          if (fetched++ >= MAX_FETCHES) throw new CertificateMonitorFailure("ct-scan-incomplete");
          const url = this.url();
          url.search = new URLSearchParams({ d: String(id) }).toString();
          certificateDer = pemCertificate((await this.read(url, 65_536, signal)).toString("ascii"));
          this.certificates.set(id, certificateDer);
        }
        entries.push({ entryId: `crtsh-${id}`, certificateDer });
      }
      return entries;
    } catch (error) {
      if (error instanceof CertificateMonitorFailure) throw error;
      // Provider responses and transport causes must not enter gateway logs.
      throw new CertificateMonitorFailure("ct-provider-unavailable");
    }
  }

  private url(): URL {
    return new URL(this.options.baseUrl ?? "https://crt.sh/");
  }
  private async read(url: URL, limit: number, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const response = await (this.options.fetch ?? fetch)(url, {
      headers: { accept: "application/json, application/pkix-cert" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // crt.sh answers 404 for a certificate it just listed when it is overloaded.
      throw new CertificateMonitorFailure(
        response.status === 404 || response.status === 429 || response.status >= 500
          ? "ct-provider-unavailable"
          : "ct-provider-refused",
      );
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // Node fetch bodies support async iteration; the DOM type also includes an empty synchronous fallback.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > limit) throw new CertificateMonitorFailure("ct-provider-invalid");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  }
}

/** Exactly one PEM certificate, nothing else. Whether it is a certificate is the monitor's check. */
function pemCertificate(text: string): Buffer {
  const match =
    /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/.exec(
      text,
    );
  const body = match?.[1]!.replace(/\r?\n/g, "");
  const der = body ? Buffer.from(body, "base64") : undefined;
  if (!der?.length || der.toString("base64") !== body)
    throw new CertificateMonitorFailure("ct-provider-invalid");
  return der;
}

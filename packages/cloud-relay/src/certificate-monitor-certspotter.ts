// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { readPrivateJson } from "./google-credentials.js";

export type CertificateMonitorError =
  | "ct-provider-unavailable"
  | "ct-provider-refused"
  | "ct-provider-invalid"
  | "ct-scan-incomplete"
  | "ct-journal-invalid"
  | "ct-journal-write-failed";
export class CertificateMonitorFailure extends Error {
  constructor(
    readonly code: CertificateMonitorError,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
export interface CertificateObservation {
  entryId: string;
  certificateDer: Buffer;
}
export interface CertificateObservationPage {
  entries: CertificateObservation[];
  lastId?: string;
  complete: boolean;
  invalidEntries: number;
  retryAfterMs?: number;
}
export interface CertificateIssuanceProvider {
  page(
    hostname: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<CertificateObservationPage>;
}
const id = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/);
const issuance = z.object({ id, cert_der: z.string().min(1).max(32_768) });
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  return value !== null && /^\d{1,8}$/.test(value)
    ? Math.min(Number(value) * 1000, 86_400_000)
    : undefined;
}

/** Real SSLMate API v1: https://sslmate.com/help/reference/ct_search_api_v1 . No relay or user tokens. */
export class CertSpotterProvider implements CertificateIssuanceProvider {
  constructor(private readonly options: { apiKeyFile?: string; fetch?: typeof fetch } = {}) {}
  async page(
    hostname: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<CertificateObservationPage> {
    try {
      signal.throwIfAborted();
      if (hostname.length > 253 || bindingOrigin(`https://${hostname}`).hostname !== hostname)
        throw new Error();
      if (after !== undefined) id.parse(after);
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.options.apiKeyFile) {
        const credentials = z
          .object({
            apiKey: z
              .string()
              .min(1)
              .max(4096)
              .regex(/^[\x21-\x7e]+$/),
          })
          .strict()
          .parse(await readPrivateJson(this.options.apiKeyFile));
        headers.authorization = `Bearer ${credentials.apiKey}`;
      }
      const url = new URL("https://api.certspotter.com/v1/issuances");
      url.searchParams.set("domain", hostname);
      url.searchParams.set("match_wildcards", "true");
      url.searchParams.set("expand", "cert_der");
      if (after !== undefined) url.searchParams.set("after", after);
      signal.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CertificateMonitorFailure(
          response.status === 429 || response.status >= 500
            ? "ct-provider-unavailable"
            : "ct-provider-refused",
          retryAfter(response),
        );
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      // Node fetch bodies support async iteration; the DOM type also includes an empty synchronous fallback.
      // eslint-disable-next-line @typescript-eslint/await-thenable
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > 1_048_576) throw new CertificateMonitorFailure("ct-provider-invalid");
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      let rows: unknown;
      try {
        rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new CertificateMonitorFailure("ct-provider-invalid");
      }
      if (!Array.isArray(rows) || rows.length > 256)
        throw new CertificateMonitorFailure("ct-provider-invalid");
      const entries: CertificateObservation[] = [];
      let invalidEntries = 0;
      for (const row of rows) {
        const parsed = issuance.safeParse(row);
        if (!parsed.success) {
          invalidEntries++;
          continue;
        }
        const certificateDer = Buffer.from(parsed.data.cert_der, "base64");
        if (!certificateDer.length || certificateDer.toString("base64") !== parsed.data.cert_der) {
          invalidEntries++;
          continue;
        }
        entries.push({ entryId: parsed.data.id, certificateDer });
      }
      return {
        entries,
        complete: rows.length === 0,
        lastId: entries.at(-1)?.entryId,
        invalidEntries,
        retryAfterMs: retryAfter(response),
      };
    } catch (error) {
      if (error instanceof CertificateMonitorFailure) throw error;
      // Provider responses, credential files and nested transport causes must not enter gateway logs.
      throw new CertificateMonitorFailure("ct-provider-unavailable");
    }
  }
}

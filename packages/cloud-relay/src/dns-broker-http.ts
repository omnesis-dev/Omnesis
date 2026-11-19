// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { BrokerError } from "./dns-broker-error.js";
import { PublicAdmissionError } from "./dns-broker-admission-budget.js";
import {
  BrowserVerificationRequired,
  boundedAdmissionJson,
} from "./dns-broker-public-admission.js";
import type { BrokerHealth } from "./dns-broker-contract.js";

export function brokerOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("The DNS broker origin must be an HTTPS origin");
  return url.origin;
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new BrokerError(415, "json-required");
  return boundedAdmissionJson(request, limit);
}

/** HTTP boundaries parse and map fixed errors; the broker service owns every state change. */
export async function brokerHttp(
  request: Request,
  service: {
    ready: Promise<void> | undefined;
    health(): BrokerHealth;
    challenge(input: unknown): Promise<unknown>;
    complete(input: unknown): Promise<unknown>;
    importRegistry?(authorization: string | null, read: () => Promise<unknown>): Promise<unknown>;
    publicAdmission?: {
      page(request: Request): Promise<Response>;
      verify(request: Request): Promise<unknown>;
    };
  },
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try {
    await service.ready;
    let result: unknown;
    if (path === "/_dns/v2/enroll" && service.publicAdmission) {
      if (request.method !== "GET") throw new BrokerError(405, "method-not-allowed");
      return await service.publicAdmission.page(request);
    } else if (path === "/_dns/v2/enroll/verify" && service.publicAdmission) {
      if (request.method !== "POST") throw new BrokerError(405, "method-not-allowed");
      result = await service.publicAdmission.verify(request);
    } else if (path === "/_dns/v2/health") {
      if (request.method !== "GET") throw new BrokerError(405, "method-not-allowed");
      result = service.health();
    } else if (
      ["/_dns/v2/challenge", "/_dns/v2/complete"].includes(path) ||
      (path === "/_dns/v2/import" && service.importRegistry)
    ) {
      if (request.method !== "POST") throw new BrokerError(405, "method-not-allowed");
      if (path === "/_dns/v2/import")
        result = await service.importRegistry!(request.headers.get("authorization"), () =>
          readJson(request, 1_048_576),
        );
      else {
        const body = await readJson(request, 16_384);
        result =
          path === "/_dns/v2/challenge"
            ? await service.challenge(body)
            : await service.complete(body);
      }
    } else throw new BrokerError(404, "not-found");
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (error) {
    const known =
      error instanceof BrokerError || error instanceof PublicAdmissionError
        ? error
        : error instanceof z.ZodError
          ? new BrokerError(400, "invalid-request")
          : new BrokerError(500, "broker-failure");
    return new Response(
      JSON.stringify({
        error: known.code,
        ...(error instanceof BrowserVerificationRequired
          ? { verification: error.verification }
          : {}),
      }),
      { status: known.status, headers },
    );
  }
}

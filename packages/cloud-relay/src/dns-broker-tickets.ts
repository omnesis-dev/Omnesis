// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { base64url, fromBase64url } from "./dns-broker-contract.js";
import type { z } from "zod";

/** Short-lived broker tickets use a dedicated key, never the DNS provider credential. */
export class BrokerTickets {
  private readonly key: Promise<CryptoKey>;
  constructor(secret: string) {
    const bytes = fromBase64url(secret);
    if (bytes.length < 32) throw new Error("DNS admission requires a dedicated 256-bit key");
    this.key = crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  }

  async seal(purpose: string, value: unknown): Promise<string> {
    const body = base64url(new TextEncoder().encode(JSON.stringify(value)));
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.key,
      new TextEncoder().encode(JSON.stringify([purpose, body])),
    );
    return `${body}.${base64url(new Uint8Array(signature))}`;
  }

  async open<T>(purpose: string, token: string, schema: z.ZodType<T>): Promise<T> {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined || token.length > 8192)
      throw new Error("Invalid DNS admission ticket");
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await this.key,
        fromBase64url(signature),
        new TextEncoder().encode(JSON.stringify([purpose, body])),
      ))
    )
      throw new Error("Invalid DNS admission ticket");
    return schema.parse(JSON.parse(new TextDecoder().decode(fromBase64url(body))));
  }

  /** A keyed, window-specific identifier avoids storing or exposing client addresses. */
  async fingerprint(purpose: string, value: string): Promise<string> {
    return base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await this.key,
          new TextEncoder().encode(JSON.stringify([purpose, value])),
        ),
      ),
    );
  }
}

/** Worker-safe address normalization; IPv6 addresses share their subscriber's /64. */
export function brokerNetworkBucket(address: string): string {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
    const bytes = address.split(".").map(Number);
    if (bytes.every((value) => value >= 0 && value <= 255)) return bytes.join(".");
  }
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    throw new Error("A trusted client address is required");
  }
  const [head = "", tail] = canonical.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  if (groups.length !== 8 || !groups.every((part) => /^[0-9a-f]{1,4}$/.test(part)))
    throw new Error("A trusted client address is required");
  const numbers = groups.map((part) => Number.parseInt(part, 16));
  if (numbers.slice(0, 5).every((value) => value === 0) && numbers[5] === 65535)
    return [numbers[6]! >> 8, numbers[6]! & 255, numbers[7]! >> 8, numbers[7]! & 255].join(".");
  return `${numbers
    .slice(0, 4)
    .map((value) => value.toString(16))
    .join(":")}::/64`;
}

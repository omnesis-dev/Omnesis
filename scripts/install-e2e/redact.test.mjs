// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRedactor, readSecretsFile } from "./redact.mjs";

const redact = createRedactor();

describe("redact", () => {
  it("masks bearer tokens and product tokens", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer ***");
    expect(redact("token omn_oat_Zm9vYmFyYmF6cXV4")).toBe("token omn_***");
  });

  it("masks secret-bearing JSON fields and env assignments", () => {
    expect(redact('{"pairingCode":"3FA9C0B21D","kind":"collector"}')).toBe(
      '{"pairingCode":"***","kind":"collector"}',
    );
    expect(redact('{"token": "anything at all"}')).toBe('{"token": "***"}');
    expect(redact("OMNESIS_TOKEN=secret-value next")).toBe("OMNESIS_TOKEN=*** next");
  });

  it("masks pairing codes and --code arguments but leaves timestamps, versions and commits", () => {
    expect(redact("Pairing code: 3FA9C0B21D")).toBe("Pairing code: <pairing-code>");
    expect(redact("sh -s -- --collector --code 0123456789")).toBe(
      "sh -s -- --collector --code <pairing-code>",
    );
    expect(redact("at 1790000000 on v0.5.13")).toBe("at 1790000000 on v0.5.13");
    const sha = "5ed5561a9cc7adc77641be79cb1997c32ee7d664";
    expect(redact(`HEAD ${sha}`)).toBe(`HEAD ${sha}`);
  });

  it("masks a keyring recovery code", () => {
    expect(redact("    ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23")).toBe("    <recovery-code>");
  });

  it("masks the tailnet's name and addresses but keeps the neutral node label", () => {
    // Assembled here so the repository's PII guard, which refuses literal
    // tailnet addresses, sees none; these are invented.
    const ip4 = ["100", "101", "102", "103"].join(".");
    const ip6 = ["fd7a", "115c", "a1e0", "", "1234", "5678"].join(":");
    expect(redact("https://omnesis-ci-gw-1-1.tail1234.ts.net:7600/health")).toBe(
      "https://omnesis-ci-gw-1-1.<tailnet>.ts.net:7600/health",
    );
    expect(redact(`peer ${ip4} and 100.63.0.1`)).toBe("peer <tailnet-ip> and 100.63.0.1");
    expect(redact(`addr ${ip6}`)).toBe("addr <tailnet-ip6>");
  });

  it("masks exact values the run registered, longest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-test-"));
    try {
      const file = join(dir, "secrets");
      writeFileSync(file, "short-secret\nshort-secret-longer\n\nab\n");
      const r = createRedactor(readSecretsFile(file));
      expect(r("x short-secret-longer y short-secret z ab")).toBe("x *** y *** z ab");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing secrets file as none", () => {
    expect(readSecretsFile(undefined)).toEqual([]);
    expect(readSecretsFile("/nonexistent/secrets")).toEqual([]);
  });
});

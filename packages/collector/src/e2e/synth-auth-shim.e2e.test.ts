// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect } from "vitest";
import type { Logger } from "@omnesis/core";
import type { AuthChallenge, SourceDescriptor } from "@omnesis/source-sdk";

/**
 * The synthetic-providers framework must give each provider a terminal-shaped
 * fake auth flow whose emitted events match the descriptor's declared
 * `authType`. From the auth-subprocess protocol's perspective this is
 * indistinguishable from a real OAuth roundtrip — callbacks fire, then the
 * flow signs with a fixed accountId.
 *
 * This test does not need a gateway — it imports synth descriptors directly
 * and drives their `authFlow()` methods.
 */
const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

describe("Synthetic providers — fake auth flows", () => {
  let descriptors: SourceDescriptor[];

  test("loads synth descriptors", async () => {
    const mod = await import("../source-descriptors.js");
    descriptors = mod.allDescriptors;
    expect(descriptors.length).toBeGreaterThan(0);
  });

  test("OAuth-typed synth providers emit a Google/Notion-looking auth URL", async () => {
    const oauthDescriptors = descriptors.filter(
      (d) => d.authType === "oauth" && d.authFlow !== undefined,
    );
    expect(oauthDescriptors.length).toBeGreaterThan(0);

    for (const desc of oauthDescriptors) {
      let urlSeen: string | null = null;
      let qrSeen: string | null = null;
      const accountId = await desc.authFlow!(undefined, {
        onAuthUrl: (url) => (urlSeen = url),
        onQrCode: (qr) => (qrSeen = qr),
      });
      expect(qrSeen, `${desc.id}: oauth flow must not emit QR codes`).toBeNull();
      expect(urlSeen, `${desc.id}: oauth flow must emit an auth URL`).not.toBeNull();
      // Synth URL shape: `https://...example/oauth?...` — contains "oauth"
      // and is non-empty.
      expect(urlSeen!).toMatch(/oauth/i);
      expect(String(accountId)).toMatch(/.+/);
    }
  });

  test("QR-typed synth providers show a pairing code through the typed session", async () => {
    // This source moved to `authenticate`, so the shim is driven through a
    // session rather than a callback bag. What is asserted is unchanged: a
    // pairing code appears, no browser redirect does, and an account resolves.
    const qrDesc = descriptors.find((d) => d.authType === "qr");
    expect(qrDesc, "expected a QR-type synth descriptor").toBeDefined();
    expect(qrDesc!.authenticate, "a QR source connects through the typed session").toBeDefined();

    const shown: AuthChallenge[] = [];
    const result = await qrDesc!.authenticate!({
      reason: "connect",
      flowId: "shim",
      supplied: {},
      host: { log: silentLog, now: () => new Date(), stateDir: "/tmp", configDir: "/tmp" },
      canShow: () => true,
      show: (challenge) => void shown.push(challenge),
      ask: () => {
        throw new Error("a pairing flow must not ask the host for an answer");
      },
    });

    const qr = shown.find((c) => c.kind === "qr");
    expect(shown.some((c) => c.kind === "redirect")).toBe(false);
    expect(qr, "a QR source shows a pairing code").toBeDefined();
    expect(qr!.kind === "qr" && qr!.data).toMatch(/^synth-qr:/);
    // The words travel with the code, so no client has to know what app this is.
    expect(qr!.title.length).toBeGreaterThan(0);
    expect(result.accounts[0]?.accountId).toMatch(/.+/);
  });

  test("Local-typed synth providers return their accountId without callbacks", async () => {
    const localDescs = descriptors.filter((d) => d.authType === "local" && d.authFlow);
    expect(localDescs.length).toBeGreaterThan(0);
    for (const desc of localDescs) {
      let any = false;
      const accountId = await desc.authFlow!(undefined, {
        onAuthUrl: () => (any = true),
        onQrCode: () => (any = true),
      });
      expect(any, `${desc.id}: local auth must not emit URL/QR`).toBe(false);
      expect(String(accountId)).toMatch(/.+/);
    }
  });

  test("discover() returns the synth identity for each source", async () => {
    for (const desc of descriptors) {
      if (!desc.discover) continue;
      const accounts = await desc.discover();
      expect(accounts.length, `${desc.id} should discover at least one account`).toBeGreaterThan(0);
      for (const aid of accounts) {
        // No leaked "demo" / "synth" prefix in user-visible identifiers.
        expect(String(aid)).not.toMatch(/^(demo|synth-)/);
      }
    }
  });
});

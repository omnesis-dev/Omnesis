// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthFlowCallbacks, AuthResult, AuthSession } from "@omnesis/source-sdk";

/**
 * Deterministic delay used in fake auth flows. Long enough that a screen
 * recording catches the QR / auth-URL screen before the portal advances to
 * the success state. Tests override via `OMNESIS_SYNTH_AUTH_DELAY_MS=50` so
 * the auth-shim suite stays fast.
 */
const FAKE_AUTH_DELAY_MS = Number(process.env.OMNESIS_SYNTH_AUTH_DELAY_MS ?? "4000");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pair markers ──────────────────────────────────────────────────
//
// Real OAuth / QR providers persist credentials on disk after a successful
// pair, so `discover()` on a later run finds the account without prompting
// the user to re-authenticate. Synth providers mimic that exactly: a
// successful auth-flow writes a tiny marker file under
// `${OMNESIS_CONFIG_DIR}/synth-pairs/`, and `preDiscoveredAccounts()`
// surfaces only accounts whose marker exists.
//
// Net effect: a fresh synth gateway has 0 pre-discovered accounts → the
// portal Add-Source wizard hits the auth-shim screen → `fakeOAuthFlow`
// fires → marker written → `setupSources()` calls `discover()`, finds the
// marker, instantiates the source → subsequent restarts also discover it.
//
// `OMNESIS_SYNTH_PRE_DISCOVERED=1` overrides everything to "always paired"
// — the E2E harness uses that so its discover-based source-config build
// doesn't have to run every auth flow first.

function pairsDir(): string {
  const base = process.env.OMNESIS_CONFIG_DIR ?? join(homedir(), ".config", "omnesis");
  return join(base, "synth-pairs");
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-.@+]/g, "_");
}

function markerPath(markerKey: string, accountId: string): string {
  return join(pairsDir(), `${safe(markerKey)}__${safe(accountId)}.json`);
}

export function markSynthPaired(markerKey: string, accountId: string): void {
  try {
    mkdirSync(pairsDir(), { recursive: true });
    writeFileSync(
      markerPath(markerKey, accountId),
      JSON.stringify({ pairedAt: new Date().toISOString() }),
    );
  } catch {
    // Best-effort — a missing marker just means the next discover() returns []
    // and the user re-pairs. No persisted creds is correct fallback behaviour.
  }
}

export function isSynthPaired(markerKey: string, accountId: string): boolean {
  try {
    return existsSync(markerPath(markerKey, accountId));
  } catch {
    return false;
  }
}

/**
 * Filter the synth identity through the pair-marker gate. Returns `accounts`
 * verbatim when `OMNESIS_SYNTH_PRE_DISCOVERED=1` (test mode); otherwise
 * returns only the accounts whose pair-marker exists on disk.
 *
 * Pass the SAME `markerKey` your auth flow uses so a successful pair flows
 * through to discover.
 */
export function preDiscoveredAccounts(markerKey: string, accounts: string[]): string[] {
  if (process.env.OMNESIS_SYNTH_PRE_DISCOVERED === "1") return accounts;
  return accounts.filter((a) => isSynthPaired(markerKey, a));
}

// ── Fake auth flows ───────────────────────────────────────────────

/**
 * Fake OAuth flow. Emits a Google/Notion/etc-looking auth URL, sleeps
 * deterministically, marks the pair, then signs the flow with the
 * configured accountId. From the auth-subprocess protocol's perspective
 * this is indistinguishable from a real OAuth roundtrip — same
 * `onAuthUrl` callback, same final `accountId` return.
 *
 * `markerKey` is the persistence key — typically the providerType
 * (`"google"`, `"notion"`) for multi-source providers, or the sourceType
 * for single-source ones. Subsequent discover() through the same key
 * skips the URL screen.
 */
export async function fakeOAuthFlow(
  markerKey: string,
  providerLabel: string,
  accountId: string,
  callbacks?: AuthFlowCallbacks,
): Promise<string> {
  const url = `https://accounts.example/oauth?provider=${encodeURIComponent(
    providerLabel.toLowerCase(),
  )}&client_id=synth&response_type=code&state=synth-${Date.now()}`;
  callbacks?.onAuthUrl?.(url);
  await sleep(FAKE_AUTH_DELAY_MS);
  markSynthPaired(markerKey, accountId);
  return accountId;
}

/** Fake local pairing — used by sources whose real flow has no browser handoff. */
export async function fakeLocalFlow(markerKey: string, accountId: string): Promise<string> {
  await sleep(FAKE_AUTH_DELAY_MS);
  markSynthPaired(markerKey, accountId);
  return accountId;
}

/** Fake QR pairing — used by WhatsApp-style sources. */
/**
 * The same pairing, through the typed session.
 *
 * A synthetic double spreads the real definition, so it inherits whatever
 * entry point the real source declares. Overriding this one is what stops a
 * demo or an end-to-end run from reaching a real phone.
 */
export async function fakeQrSession(
  markerKey: string,
  accountId: string,
  session: AuthSession,
  copy: { title: string; instructions?: string },
): Promise<AuthResult> {
  session.show({ kind: "qr", ...copy, data: `synth-qr:${accountId}` });
  await sleep(FAKE_AUTH_DELAY_MS);
  markSynthPaired(markerKey, accountId);
  return { accounts: [{ accountId, state: { status: "connected" } }] };
}

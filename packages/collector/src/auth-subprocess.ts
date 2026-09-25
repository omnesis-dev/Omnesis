// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Subprocess script for running auth flows in isolation.
 * Invoked by the collector's auth endpoint to avoid Baileys state pollution.
 *
 * Usage: npx tsx auth-subprocess.ts <descriptorId> [paramsJson]
 * Output: NDJSON lines to stdout ({ type: "url"|"qr"|"complete"|"error", ... })
 */

export {}; // Make this a module for top-level await

import {
  DEFAULT_CONFIG_DIR,
  redactSecrets,
  type Logger,
  primeSecretFileKeyCache,
  secretFileEncryptionRequired,
} from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import { authErrorPayload } from "./auth-subprocess-error.js";
import { validateAuthAccounts } from "./auth-subprocess-result.js";
import { makeSession } from "./auth-subprocess-session.js";
import { emit, emitFinal, keyringUnavailableNotice } from "./auth-subprocess-emit.js";
import { createStdinReceiver } from "./auth-subprocess-stdin.js";
import type { AuthSession, ConnectionState } from "@omnesis/source-sdk";

const stdout = process.stdout;

// Inbound NDJSON channel from the parent (`source-ws-handlers.ts`): an
// `init` line carrying the gateway flow id, then optionally a `code`
// line delivering the authorization code routed through the gateway.
// Created before anything else so no early frame is missed.
const stdinReceiver = createStdinReceiver(process.stdin);

// Swallow stray promise rejections from provider auth flows.
//
// Baileys' WhatsApp pairing path (`useMultiFileAuthState`) keeps a
// background writer that periodically flushes the in-memory auth state
// to disk. `pairFlow` in `packages/providers/whatsapp/src/provider.ts`
// atomically renames `whatsapp/_pairing/` → `whatsapp/<phone>/` once the
// QR scan succeeds, and Baileys' writer — which still holds the
// pre-rename path internally — fires off a `fs.open('.../_pairing/...')`
// that immediately rejects with ENOENT.
//
// On Node ≥15 an unhandled rejection terminates the process. Without
// this handler the subprocess died mid-flow (after rename, before
// `emitFinal(complete)`), the parent saw stdout EOF without a terminal
// event, and the portal surfaced "auth subprocess exited without a
// complete event" — even though pairing succeeded on WhatsApp's side
// and the new creds were on disk. The bug was masked on Bun (which
// warns rather than terminates on unhandled rejection) and surfaced
// after the Bun → Node migration.
//
// The handler also covers any analogous transient rejections from
// other provider auth flows. Routing to stderr (not stdout) keeps the
// NDJSON protocol the parent parses clean, and the parent's stderr
// listener surfaces these as `debug` logs.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[auth-subprocess] swallowed unhandledRejection: ${msg}\n`);
});

const descriptorId = process.argv[2];
const paramsJson = process.argv[3];

if (!descriptorId) {
  await emitFinal(stdout, { type: "error", error: "Missing descriptorId argument" });
  process.exit(1);
}

const params = paramsJson ? JSON.parse(paramsJson) : undefined;
const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
const primed = await primeSecretFileKeyCache({ configDir }).catch(() => false);
// A marker that cannot be read is itself a reason to warn, so an unreadable
// keyring resolves to "encryption is in use" rather than propagating: this line
// exists to report that condition, not to die of it.
let encryptionRequired: boolean;
try {
  encryptionRequired = secretFileEncryptionRequired(configDir);
} catch {
  encryptionRequired = true;
}
const keyringNotice = keyringUnavailableNotice({
  primed,
  encryptionRequired,
  backend: process.env.OMNESIS_SECRET_STORE,
});
if (keyringNotice) process.stderr.write(keyringNotice);

// Dynamic import of the descriptors module to get the descriptor.
const { allDescriptors } = await import("./source-descriptors.js");

const descriptor = allDescriptors.find((d) => String(d.id) === descriptorId);
if (!descriptor?.authFlow && !descriptor?.authenticate) {
  await emitFinal(stdout, { type: "error", error: `No auth flow for ${descriptorId}` });
  process.exit(1);
}

// Resolved from the parent's `init` line (≤5s; `undefined` if the parent
// never sends one). Awaited before invoking the provider so flows that
// embed `state=<flowId>` in their authorize URL have it from the start.
// `reauthAccountId` is set only when the flow re-authenticates an
// existing account — providers may use it to reuse stored parameters.
const flowId = await stdinReceiver.flowId();
const rawReauthAccountId = await stdinReceiver.accountId();
const publicBaseUrl = await stdinReceiver.publicBaseUrl();
// What the client that started this flow says it can draw. A client that says
// nothing gets only the redirect and QR kinds the legacy protocol can carry.
const declaredRenders = await stdinReceiver.renders();
// Pasted fields for a `perAccount` spec, already validated against the spec by
// the parent. The provider persists them only after its probe resolves an id.
const credentials = await stdinReceiver.credentials();

// Constrain the re-auth account id before any provider can use it: it selects
// the path a credential is written to and, on removal, the directory that gets
// deleted. `AccountId` is what rejects path separators, NUL and `.`/`..`, and
// this is the seam where an id first becomes trusted — every hop before it is
// an unconstrained string.
let reauthAccountId: string | undefined;
try {
  reauthAccountId =
    rawReauthAccountId === undefined ? undefined : String(AccountId(rawReauthAccountId));
} catch {
  await emitFinal(stdout, { type: "error", error: `Invalid accountId for re-auth` });
  process.exit(1);
}

/**
 * A connection state with every sentence in it redacted.
 *
 * Two of its arms carry free text a provider wrote — why a credential could
 * not be read, what a revocation said — and those reach the same record as any
 * other prose this process reports.
 */
function redactState(state: ConnectionState, secrets: string[]): ConnectionState {
  const clean = (value: unknown): unknown =>
    typeof value === "string" ? redactSecrets(value, secrets) : value;
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, clean(value)]),
  ) as unknown as ConnectionState;
}

/** Values that must never appear in anything this flow reports upward. */
// Known bug: #2702 — masks every credential field, not only the ones the spec marks secret.
const secretValues: string[] = Object.values(credentials ?? {}).filter((v) => v.length > 0);

/**
 * Which application credential this provider needs, for the one failure a
 * client acts on. Absent for a provider that brings its own.
 */
const credentialRouting = descriptor.credentials?.fileKey
  ? { fileKey: descriptor.credentials.fileKey, providerName: String(descriptor.provider.name) }
  : undefined;

/**
 * A logger for a process whose stdout is a protocol.
 *
 * Everything a flow logs goes to stderr, which the parent drains into a
 * bounded window with the same redaction applied. Writing a diagnostic to
 * stdout would put a non-protocol line into the NDJSON the parent parses.
 */
const sessionLog: Logger = (() => {
  const write = (level: string) => (message: string) => {
    process.stderr.write(`[auth-subprocess] ${level} ${redactSecrets(message, secretValues)}\n`);
  };
  const logger: Logger = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: () => logger,
  };
  return logger;
})();

/** The directory this provider's own state lives under. */
const providerDir = String(descriptor.provider.id);

/** The operator's side of this run, built from what it was started with. */
const session = (): AuthSession =>
  makeSession({
    flowId: flowId ?? "",
    reauthAccountId,
    publicBaseUrl,
    configDir,
    providerDir,
    // Whatever a client of the older shape collected up front: the credential
    // fields from its wizard, and the source parameters from its form.
    supplied: { ...params, ...credentials },
    declaredRenders,
    secretValues,
    receiver: stdinReceiver,
    emit: (event) => emit(stdout, event),
    log: sessionLog,
  });

if (descriptor.authenticate) {
  try {
    const result = await descriptor.authenticate(session());
    const accountIds = validateAuthAccounts(
      result.accounts.map((a) => String(a.accountId)),
      reauthAccountId,
    );
    // Redacted for the reason the failure path is: both of these are prose a
    // provider composed, they land on the flow record, and
    // `GET /admin/auth-flows` returns every flow to every admin caller. A
    // provider that names the value it was handed while explaining what it
    // could not do with it would otherwise put that value there.
    await emitFinal(stdout, {
      type: "complete",
      accountIds,
      accountStates: Object.fromEntries(
        result.accounts.map((a) => [String(a.accountId), redactState(a.state, secretValues)]),
      ),
      ...(result.notices?.length
        ? {
            notices: result.notices.map((notice) => ({
              title: redactSecrets(notice.title, secretValues),
              ...(notice.detail ? { detail: redactSecrets(notice.detail, secretValues) } : {}),
            })),
          }
        : {}),
    });
    process.exit(0);
  } catch (err) {
    await emitFinal(stdout, authErrorPayload(err, { secretValues, routing: credentialRouting }));
    process.exit(1);
  }
}

try {
  const result = await descriptor.authFlow!(
    params,
    {
      onAuthUrl: (url: string) => emit(stdout, { type: "url", url }),
      onQrCode: (qr: string) => emit(stdout, { type: "qr", data: qr }),
      onWidgetConfig: (config) => emit(stdout, { type: "widget", ...config }),
      receiveCode: () => stdinReceiver.receiveCode(),
      receiveWidgetResult: () => stdinReceiver.receiveWidgetResult(),
      flowId,
      accountId: reauthAccountId,
      credentials,
      publicBaseUrl,
    },
    { configDir },
  );
  // Normalise the scalar / array `authFlow` return to the single
  // `accountIds` wire shape so the consumer has one form to handle.
  const accountIds = validateAuthAccounts(
    (Array.isArray(result) ? result : [result]).map(String),
    reauthAccountId,
  );
  await emitFinal(stdout, { type: "complete", accountIds });
  process.exit(0);
} catch (err) {
  await emitFinal(stdout, authErrorPayload(err, { secretValues, routing: credentialRouting }));
  process.exit(1);
}

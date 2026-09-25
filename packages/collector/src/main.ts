// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Load $OMNESIS_CONFIG_DIR/.env before any env read (incl. resolveGatewayUrl).
import "./load-env.js";
import { pathToFileURL } from "node:url";
import {
  applyPrivateUmask,
  acquireUpdateLock,
  createLogger,
  toErrorMessage,
  DEFAULT_CONFIG_DIR,
  readTokenFile,
  readCollectorTokenFile,
  writeCollectorTokenFile,
  ensureGatewayTrust,
  GatewayCertificateChangedError,
  isTlsCertError,
  classifyCollectorAuth,
  credentialEverAuthenticated,
  needsPairingLogLine,
  readCollectorPairingState,
  repairCommandFor,
  tokenFingerprint,
  writeCollectorPairingState,
  discoverGatewayViaMdns,
  localGatewayRequestUrl,
  primeSecretFileKeyCache,
  readPackageVersion,
  runningSourceCommit,
  SOURCE_CONTRACT_WIRE_RANGE,
  type AudioTranscribeFn,
  type OcrFn,
  type WsCommand,
  type WsRequestPayload,
  type WsResponsePayload,
  setDefaultPhoneRegion,
} from "@omnesis/core";
import {
  HttpGatewayClient,
  GatewayWsClient,
  requireGatewaySourceContract,
} from "@omnesis/gateway-client";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import { SyncEngine } from "./sync-engine.js";
import {
  createConfigRefreshQueue,
  fetchConfigWithBackoff,
  toLegacyConfig,
} from "./gateway-config.js";
import { SourceManager } from "./source-manager.js";
import { buildSourceRemovedAck } from "./ws-ack-builders.js";
import { createAttachmentExtractor } from "./attachments/index.js";
import { createSourceWsHandlers } from "./source-ws-handlers.js";
import { createCommandDispatch, type CommandDispatch } from "./ws-command-dispatch.js";
import { createCliUpdater, registerSelfUpdateCommand } from "./self-update.js";
import { handOverToServiceManager } from "./service-restart.js";
import { isBaileysAuthEnoent } from "./baileys-enoent-filter.js";
import { collectorDeviceName } from "./device-name.js";
import { CollectorDoctor } from "./doctor.js";
import { prepareCollectorStorageEncryption } from "./storage-encryption.js";
import { CollectorDoctorVitals } from "./doctor-process-vitals.js";
import { createGatewayCommandHandler } from "./gateway-command-handler.js";

/**
 * Product version of this collector build, announced in every hello so the
 * gateway's version ledger can tell a current collector from one whose host
 * has not been updated.
 */
const COLLECTOR_VERSION = readPackageVersion(import.meta.url);
const COLLECTOR_STARTED_AT = Date.now();
import { detectDocumentIngestionContext } from "./phone-region.js";
import { toSyncStatusPayload } from "./sync-status-payload.js";
import { startEventLoopWatchdog } from "./event-loop-watchdog.js";
import type { ConfigStatusResult } from "@omnesis/core/doctor";
import type { TriggerSyncResult } from "./sync-dispatcher.js";
import type { OmnesisConfig } from "@omnesis/config";

const log = createLogger("collector");
applyPrivateUmask();

const DEFAULT_GATEWAY_URL = "https://localhost:7600";

/**
 * How often a disconnected collector asks the gateway whether its credential
 * is still good. Long enough that a gateway restart or a flaky link never
 * costs more than one probe per minute; short enough that an operator who
 * has just revoked a device sees the collector park itself while they are
 * still watching.
 */
const PAIRING_WATCHDOG_INTERVAL_MS = 60_000;

/** Bound on one credential probe. Shorter than the watchdog's own interval. */
const PROBE_TIMEOUT_MS = 15_000;

/** Wallclock cap on draining in-flight syncs before the process stops. */
const SHUTDOWN_DRAIN_MS = 30_000;

function ocrEnabledFromConfig(config: OmnesisConfig): boolean {
  const assignment = config.inference?.assignments?.ocr;
  return (
    typeof assignment === "string" &&
    assignment.trim().length > 0 &&
    assignment.trim() !== "disabled"
  );
}

/**
 * Resolve the gateway URL the collector should connect to.
 *
 * Priority:
 *   1. `OMNESIS_GATEWAY_URL` env var — explicit operator override, used as-is.
 *   2. `OMNESIS_MDNS_DISABLE=1` — skip discovery, fall straight to localhost.
 *   3. mDNS / Bonjour LAN discovery — find an `_omnesis._tcp` gateway on
 *      the same LAN. On a hit, use its URL (and surface the advertised TLS
 *      fingerprint for the TOFU flow); on a miss, fall back to localhost.
 *
 * The discovered fingerprint is returned so `main()` can hand it to the
 * trust flow as the first-sight fingerprint — a non-interactive collector on
 * a fresh host can then trust the discovered gateway without a TTY prompt.
 */
export async function resolveGatewayUrl(): Promise<{ url: string; fingerprint?: string }> {
  const override = process.env.OMNESIS_GATEWAY_URL;
  if (override) return { url: override };

  if (process.env.OMNESIS_MDNS_DISABLE === "1") return { url: DEFAULT_GATEWAY_URL };

  const discovered = await discoverGatewayViaMdns({ timeoutMs: 3000 });
  if (discovered) {
    log.info(`Discovered gateway via mDNS at ${discovered.url}`);
    return { url: discovered.url, fingerprint: discovered.fingerprint };
  }
  return { url: DEFAULT_GATEWAY_URL };
}

/** Convert the engine's source-id buckets into the numeric WS acknowledgement contract. */
function toSourceSyncResponse(result: TriggerSyncResult): WsResponsePayload<"source.sync"> {
  return {
    ok: !result.error,
    triggered: result.triggered.length,
    skipped: result.skipped.length,
    disabled: result.disabled.length,
    restarting: result.restarting.length,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Answer a `source.sync` command: route the requested source to the engine and
 * map its result buckets to the protocol's counts. A `restart` starts the
 * source over, aborting a run already in flight; the answer comes back at
 * once, before that run has unwound.
 */
export function handleSourceSyncCommand(
  engine: Pick<SyncEngine, "triggerSync">,
  payload: WsRequestPayload<"source.sync">,
): WsResponsePayload<"source.sync"> {
  return toSourceSyncResponse(
    engine.triggerSync(payload.sourceId, { restart: payload.restart === true }),
  );
}

/**
 * Register the gateway-owned source update path on the collector dispatcher.
 * Updates must flow through snapshot reconciliation: toggling enabled state
 * alone would discard persisted source metadata such as multi-device mode.
 */
export function registerSourceUpdatedCommand(
  dispatch: CommandDispatch,
  manager: Pick<SourceManager, "applySourcesSnapshot">,
): void {
  dispatch.register("source.updated", async ({ source }) => {
    if (!source) return { ok: true, applied: false };
    log.info(`Gateway → collector source.updated: ${source.id} enabled=${source.enabled}`);
    try {
      await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: true };
    } catch (err) {
      log.error(`source.updated handler failed for ${source.id}: ${toErrorMessage(err)}`);
      return { ok: false, error: toErrorMessage(err) };
    }
  });
}

/**
 * Block until the gateway responds to /health, and return the URL that
 * answered. Token-independent — used before the auto-pair probe so we don't
 * fail-fast on startup race.
 *
 * A gateway on this machine is tried over loopback first. `OMNESIS_GATEWAY_URL`
 * records the address other machines use, which may not resolve here: a
 * collector unit written before installs recorded loopback for it still names
 * `omnesis.local`, which Homebrew's node cannot resolve on macOS. The check
 * runs on every attempt because at boot the collector can start before its
 * gateway holds the config directory. The recorded address is still tried
 * when loopback does not answer — a certificate that does not name localhost
 * (an operator-supplied or tailnet one) is reached by the name it carries —
 * and only the recorded address runs the trust flow, so loopback never pins
 * a certificate.
 *
 * Trust-aware: when a supervisor starts collector and gateway together on
 * the same host, the collector's startup trust step can run before the
 * gateway has generated its self-signed cert — the saved cert appears on
 * disk only after the gateway boots. On a TLS cert error this loop re-runs
 * the trust flow so the freshly written `<configDir>/tls/cert.pem` gets
 * picked up instead of looping on an untrusted handshake forever.
 */
export async function waitForGateway(
  gatewayUrl: string,
  configDir: string,
  discoveredFingerprint: string | undefined,
): Promise<string> {
  const deadlineLog = 5000;
  // Once a rotation has been refused nothing changes without the operator;
  // the probe that re-reads the served certificate then runs every 30 s.
  const refusedRetryMs = 30_000;
  let lastLog = 0;
  let nextTrustAttempt = 0;
  let certificateChanged: GatewayCertificateChangedError | null = null;
  while (true) {
    const local = localGatewayRequestUrl(gatewayUrl, configDir);
    if (local !== gatewayUrl) {
      try {
        const res = await fetch(`${local}/health`);
        if (res.ok) {
          log.info(
            `The gateway on this machine answers at ${local}; using it instead of ${gatewayUrl}`,
          );
          return local;
        }
      } catch {
        // Not over loopback; the recorded address is tried next.
      }
    }
    try {
      const res = await fetch(`${gatewayUrl}/health`);
      if (res.ok) return gatewayUrl;
    } catch (err) {
      if (isTlsCertError(err) && Date.now() >= nextTrustAttempt) {
        try {
          // A saved certificate the gateway no longer serves is followed only
          // when the operator's OMNESIS_TRUST_FINGERPRINT names the new one;
          // the refusal says what to check before re-trusting.
          await ensureGatewayTrust({
            gatewayUrl,
            configDir,
            discoveredFingerprint,
            verifyServed: true,
          });
        } catch (trustErr) {
          if (trustErr instanceof GatewayCertificateChangedError) {
            if (certificateChanged?.servedFingerprint !== trustErr.servedFingerprint) {
              log.error(trustErr.message);
            }
            certificateChanged = trustErr;
            nextTrustAttempt = Date.now() + refusedRetryMs;
          }
        }
      }
    }
    if (Date.now() - lastLog > deadlineLog) {
      const where = local === gatewayUrl ? gatewayUrl : `${gatewayUrl} (or ${local})`;
      log.warn(
        certificateChanged
          ? `Waiting for gateway at ${where}: its certificate changed (sha256:${certificateChanged.servedFingerprint}) and is not trusted here`
          : `Waiting for gateway at ${where}...`,
      );
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * HTTP status the gateway answered a token probe with, or null on no answer.
 * The body is discarded without being read — only the status matters, and
 * `/config` is large enough that draining it every minute would be waste.
 * Bounded, because a blackholed link never answers and never errors either.
 */
async function probeTokenStatus(gatewayUrl: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(`${gatewayUrl}/config`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/** What `resolveCollectorToken` concluded. */
export type CollectorTokenResolution =
  | { outcome: "token"; token: string }
  /** The gateway refused a credential that used to work: revoked device. */
  | { outcome: "needs-pairing" };

/**
 * Resolve the collector's auth token, self-pairing if necessary.
 *
 * Priority:
 *   1. `<configDir>/collector-token` (the token written by a prior
 *      self-pair). If it still authenticates, use it.
 *   2. Fall back to `OMNESIS_TOKEN` / `<configDir>/token` (bootstrap admin)
 *      and self-pair a `kind=collector` device under this host's name with
 *      the collector kind's canonical grant (`defaultScopesForDeviceKind`).
 *      Save the returned token to `collector-token` so subsequent runs skip
 *      pairing. The gateway adopts a revoked row of the same name and kind,
 *      so a revoked local collector comes back onto its own identity.
 *
 * The self-pair branch covers two real scenarios:
 *   - First run after `omnesis devices revoke <this-collector>` on the
 *     gateway host: the prior collector token is dead but the bootstrap
 *     admin token is intact.
 *   - Fresh install: only the bootstrap token exists; the collector should
 *     self-register rather than the operator running curl by hand.
 *
 * Self-pairing needs an admin credential, which a revoked device does not
 * have — deliberately, because letting one back in is exactly what revoking
 * exists to prevent. When the credential that used to work is refused and no
 * admin credential is at hand, this returns `needs-pairing` so the caller can
 * say so once and stop, rather than retrying a token that will never be
 * accepted again. The recovery is an operator-minted repair code.
 */
export async function resolveCollectorToken(
  gatewayUrl: string,
  configDir: string,
): Promise<CollectorTokenResolution> {
  const persisted = readCollectorPairingState(configDir);
  const deviceName = collectorDeviceName();

  // A saved collector token from a prior self-pair is always preferred.
  const existing = readCollectorTokenFile(configDir);
  let existingWasRefused = false;
  if (existing) {
    const verdict = classifyCollectorAuth({
      status: await probeTokenStatus(gatewayUrl, existing),
      everAuthenticated: credentialEverAuthenticated(persisted, { token: existing, gatewayUrl }),
    });
    if (verdict === "authenticated") {
      recordCollectorPaired({ configDir, gatewayUrl, deviceName, token: existing });
      return { outcome: "token", token: existing };
    }
    existingWasRefused = verdict === "needs-pairing";
  }

  // Find a bootstrap/admin token to self-pair with. OMNESIS_TOKEN env var
  // takes priority (remote collectors where the token file isn't local),
  // then the local token file.
  const bootstrap = process.env.OMNESIS_TOKEN || readTokenFile(configDir);
  if (!bootstrap) {
    if (existingWasRefused) return { outcome: "needs-pairing" };
    throw new Error(
      "No auth token found. Start the gateway first (auto-generates one), or set OMNESIS_TOKEN.",
    );
  }

  const os = await import("node:os");
  log.info(
    `No valid collector token found — self-pairing as ${deviceName} using bootstrap admin token`,
  );

  const res = await fetch(`${gatewayUrl}/admin/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrap}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: deviceName,
      kind: "collector",
      scopes: defaultScopesForDeviceKind("collector"),
      capabilities: {
        hostname: os.hostname(),
        platform: process.platform,
        version: COLLECTOR_VERSION,
      },
    }),
  });
  if (!res.ok) {
    // The credential offered as bootstrap is not an admin one either. If some
    // credential here used to be accepted by this gateway, that is a revoke:
    // this host cannot self-pair its way back and must say so once.
    const verdict = classifyCollectorAuth({
      status: res.status,
      everAuthenticated:
        existingWasRefused ||
        credentialEverAuthenticated(persisted, { token: bootstrap, gatewayUrl }),
    });
    if (verdict === "needs-pairing") return { outcome: "needs-pairing" };
    const txt = await res.text().catch(() => "");
    throw new Error(`Self-pair failed (${res.status}): ${txt || "unknown error"}`);
  }
  const body = (await res.json()) as {
    token?: string;
    reclaimed?: boolean;
    device?: { id: string; name: string };
  };
  if (!body.token) throw new Error("Self-pair response missing token");

  const tokenPath = writeCollectorTokenFile(body.token, configDir);
  log.info(
    `${body.reclaimed ? "Reclaimed" : "Self-paired"} collector device id=${body.device?.id} → token saved to ${tokenPath}`,
  );
  recordCollectorPaired({ configDir, gatewayUrl, deviceName, token: body.token });
  return { outcome: "token", token: body.token };
}

/** Persist "this credential authenticated" so a later 401 is classifiable. */
function recordCollectorPaired(input: {
  configDir: string;
  gatewayUrl: string;
  deviceName: string;
  token: string;
}): void {
  writeCollectorPairingState(input.configDir, {
    state: "paired",
    deviceName: input.deviceName,
    gatewayUrl: input.gatewayUrl,
    tokenFingerprint: tokenFingerprint(input.token),
    lastAuthenticatedAt: Date.now(),
    unauthorizedAt: null,
    repairCommand: null,
  });
}

/**
 * Record the lockout, say it once, and stop. There is nothing this process
 * can do without a credential, and a daemon that keeps knocking on a 401
 * buries the one line that explains the fix. A clean exit parks the unit on
 * both platforms — systemd's `Restart=on-failure` and launchd's
 * `KeepAlive { SuccessfulExit: false }` — leaving the reason on disk for
 * `omnesis service status` to read, so the operator starts the collector
 * again once the repaired credential is saved.
 */
async function haltForRepair(input: {
  configDir: string;
  gatewayUrl: string;
  deviceName: string;
  token: string | null;
  lastAuthenticatedAt: number | null;
}): Promise<never> {
  writeCollectorPairingState(input.configDir, {
    state: "needs-pairing",
    deviceName: input.deviceName,
    gatewayUrl: input.gatewayUrl,
    tokenFingerprint: input.token ? tokenFingerprint(input.token) : "",
    lastAuthenticatedAt: input.lastAuthenticatedAt,
    unauthorizedAt: Date.now(),
    repairCommand: repairCommandFor(input.deviceName),
  });
  log.error(
    needsPairingLogLine({
      deviceName: input.deviceName,
      gatewayUrl: input.gatewayUrl,
      configDir: input.configDir,
    }),
  );
  // Writes to a pipe — which is what stderr is under a service manager — are
  // asynchronous on POSIX, and `process.exit` does not flush them. The line
  // above is the whole recovery path, so wait for it to leave the process.
  await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
  process.exit(0);
}

/**
 * Collector daemon entrypoint. Exported so `omnesis collector run` can host
 * the collector inside the CLI binary; also launched directly when this
 * module is the process entrypoint (see the guard at the bottom).
 */
export async function main() {
  // First, so a stall anywhere in the startup below is bounded too.
  startEventLoopWatchdog();
  const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  const sourceCommit = runningSourceCommit(configDir, import.meta.url, COLLECTOR_STARTED_AT);
  await primeSecretFileKeyCache({ configDir }).catch((err) => {
    log.warn(
      `Could not prime secret-file root key cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // The keys the provider stores open with must exist on this host before
  // the first sync; a collector that cannot honour armed encryption refuses
  // to start rather than opening a store plaintext.
  await prepareCollectorStorageEncryption(configDir).catch(async (err) => {
    log.error(`Cannot start: ${err instanceof Error ? err.message : String(err)}`);
    // The line above is the whole remedy; let it leave the stderr pipe.
    await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
    process.exit(1);
  });

  const { url: requestedGatewayUrl, fingerprint } = await resolveGatewayUrl();

  // A gateway discovered over mDNS publishes its TLS fingerprint in the
  // service TXT record. It stands in for OMNESIS_TRUST_FINGERPRINT on first
  // sight, so the self-signed cert is accepted non-interactively — and for
  // first sight only: trust already saved is never moved by a LAN record.
  const discoveredFingerprint = fingerprint ?? undefined;

  try {
    const tofu = await ensureGatewayTrust({
      gatewayUrl: requestedGatewayUrl,
      configDir,
      discoveredFingerprint,
    });
    if (tofu.action === "insecure-mode") {
      log.warn("OMNESIS_INSECURE_TLS is set — TLS certificate verification disabled");
    }
  } catch (err) {
    log.error(`TLS trust failed: ${toErrorMessage(err)}`);
    process.exit(1);
  }

  const gatewayUrl = await waitForGateway(requestedGatewayUrl, configDir, discoveredFingerprint);
  const requireSourceContract = () => requireGatewaySourceContract(gatewayUrl);
  // Refuse before pairing, loading sources, or starting authentication. The
  // same check guards requests and commands for a gateway replaced at runtime.
  await requireSourceContract();

  const deviceName = collectorDeviceName();
  const halt = (): Promise<never> =>
    haltForRepair({
      configDir,
      gatewayUrl,
      deviceName,
      token: readCollectorTokenFile(configDir),
      lastAuthenticatedAt: readCollectorPairingState(configDir)?.lastAuthenticatedAt ?? null,
    });

  let resolved: CollectorTokenResolution;
  try {
    resolved = await resolveCollectorToken(gatewayUrl, configDir);
  } catch (err) {
    log.error(toErrorMessage(err));
    process.exit(1);
  }
  // `halt` exits the process; returning it also narrows `resolved` below.
  if (resolved.outcome === "needs-pairing") return halt();
  const token = resolved.token;

  log.info(`Starting collector → ${gatewayUrl}`);

  const gateway = new HttpGatewayClient(gatewayUrl, token, {
    beforeRequest: requireSourceContract,
  });
  log.info(`Connected to gateway at ${gatewayUrl}`);

  const os = await import("node:os");
  const ingestionContext = detectDocumentIngestionContext();
  setDefaultPhoneRegion(ingestionContext.phoneRegion);
  log.info(
    `Phone region ${ingestionContext.phoneRegion} (${ingestionContext.phoneRegionSource}, locale ${ingestionContext.locale ?? "unknown"})`,
  );

  // Fetch the unified config from the gateway. Retries forever with backoff;
  // returns a cached copy (<24h old) as a stopgap if the gateway is briefly
  // unreachable at boot. WS `config.changed` drives live updates.
  let configStatus: ConfigStatusResult = {
    ok: true,
    version: 0,
    lastLoadedAt: 0,
    lastWrittenAt: null,
    lastError: null,
  };
  const configFetchContext = {
    gateway,
    configDir,
    onLoaded: (version: number) => {
      configStatus = {
        ok: true,
        version,
        lastLoadedAt: Date.now(),
        lastWrittenAt: null,
        lastError: null,
      };
    },
    onLoadError: (error: Error) => {
      configStatus = {
        ...configStatus,
        ok: false,
        lastError: { at: Date.now(), message: error.message },
      };
    },
  };
  const unifiedConfig = await fetchConfigWithBackoff(configFetchContext);
  let ocrEnabled = ocrEnabledFromConfig(unifiedConfig);
  const config = toLegacyConfig(unifiedConfig);

  const engine = new SyncEngine(gateway, { ingestionContext });
  // Voice notes are transcribed through the gateway. Image / scanned-PDF OCR is
  // additionally gated by the live config assignment so "OCR disabled" never
  // turns into a sync-time call to /inference/ocr.
  const transcribeAudio: AudioTranscribeFn = (data, mimeType, opts) =>
    gateway.transcribe(data, mimeType, opts);
  const ocr: OcrFn = (data, mimeType, opts) => gateway.ocr(data, mimeType, opts);
  const manager = new SourceManager(engine, gateway, config, {
    // STT feeds two paths from the same gateway fn: conversation sources get
    // `transcribeAudio` for inline transcription (threaded per-source by the
    // instantiator), and document sources get it inside the shared extractor as
    // `transcribe` so audio attachments become child docs.
    extractAttachment: createAttachmentExtractor({
      ocr,
      ocrEnabled: () => ocrEnabled,
      transcribe: transcribeAudio,
    }),
    transcribeAudio,
    configDir,
    ingestionContext,
  });

  // Source registry is owned by the gateway. The collector waits for
  // the `sources.snapshot` WS command below to learn which sources to host.

  // Gateway WebSocket: bidirectional. Used for:
  //   - sync.status events emitted upstream (gateway sync-status registry)
  //   - source.add/remove/update/sync/debug commands from gateway (Phase 2)
  //   - sources.snapshot push from gateway on connect (Phase 2)
  //
  // IMPORTANT: connect to the gateway BEFORE starting the initial sync loop.
  // engine.startSyncLoop() awaits Promise.allSettled across every source's
  // initial sync — for users with large backlogs (e.g. 100k+ Gmail messages)
  // that can take hours. Without an upstream WS connection during that time,
  // the gateway's SyncStatusRegistry stays empty and reconnection after a
  // gateway restart never happens (wsClient.connect() would be queued behind
  // the unfinished sync).
  // A gateway that rotates its certificate while this collector is up: the
  // socket fails to verify, and before the next attempt the saved copy is
  // re-read (on the gateway host that is the gateway's own file, so the new
  // certificate is followed at once) or the refusal is logged, once per
  // certificate.
  let refusedFingerprint: string | null = null;
  let retrustInFlight = false;
  const retrustOnCertError = (error: unknown): void => {
    if (!isTlsCertError(error) || retrustInFlight) return;
    retrustInFlight = true;
    void ensureGatewayTrust({ gatewayUrl, configDir, discoveredFingerprint, verifyServed: true })
      .then(() => {
        refusedFingerprint = null;
      })
      .catch((trustErr: unknown) => {
        if (trustErr instanceof GatewayCertificateChangedError) {
          if (refusedFingerprint !== trustErr.servedFingerprint) {
            refusedFingerprint = trustErr.servedFingerprint;
            log.error(trustErr.message);
          }
        } else {
          log.warn(`Gateway certificate could not be re-checked: ${toErrorMessage(trustErr)}`);
        }
      })
      .finally(() => {
        retrustInFlight = false;
      });
  };

  const wsClient = new GatewayWsClient(gatewayUrl, token, {
    onSocketError: retrustOnCertError,
    capabilities: {
      sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
      hostname: os.hostname(),
      platform: process.platform,
      version: COLLECTOR_VERSION,
      ...(sourceCommit ? { sourceCommit } : {}),
      locale: ingestionContext.locale,
      phoneRegion: ingestionContext.phoneRegion,
      hostableSourceTypes: manager.getDescriptors().map((d) => d.id),
      syncLease: true,
      deviceDoctor: true,
      pushBasedSourceTypes: manager
        .getDescriptors()
        .filter((d) => d.pushBased)
        .map((d) => d.id),
      multiDeviceModes: Object.fromEntries(
        manager
          .getDescriptors()
          .flatMap((d) =>
            d.multiDevice && d.multiDevice.mode !== "exclusive"
              ? [[d.id, d.multiDevice.mode] as const]
              : [],
          ),
      ),
      replicaVersionPolicies: Object.fromEntries(
        manager
          .getDescriptors()
          .flatMap((descriptor) =>
            descriptor.multiDevice?.replicaVersionPolicy
              ? [[descriptor.id, descriptor.multiDevice.replicaVersionPolicy] as const]
              : [],
          ),
      ),
      memberScopedParams: Object.fromEntries(
        manager.getDescriptors().map((descriptor) => [
          descriptor.id,
          // The source's whole member-scoped declaration, not the subset a
          // form renders: an advanced setting is still one this device owns,
          // and leaving it out of the contract makes it unwritable.
          // No fallback to the form's parameter list: that is the shape this
          // replaced, and reinstating it for a descriptor arriving without the
          // field would quietly bring the defect back.
          descriptor.memberScopedParamNames ?? [],
        ]),
      ),
    },
  });

  const refreshConfig = createConfigRefreshQueue(configFetchContext, async (next) => {
    ocrEnabled = ocrEnabledFromConfig(next);
    await manager.handleConfigChange(toLegacyConfig(next));
  });
  wsClient.onEvent((event, payload) => {
    if (event === "config.changed") {
      // Gateway broadcasts this on every successful config write (file edit,
      // PATCH /admin/config, PUT /admin/config). Re-fetch and apply.
      void (async () => {
        try {
          await refreshConfig();
          log.info("Config updated from gateway");
        } catch (err) {
          log.warn(`Failed to refresh config after gateway event: ${toErrorMessage(err)}`);
        }
      })();
    }
  });

  // Forward sync engine status changes upstream as `sync.status` events
  // so the gateway's SyncStatusRegistry can serve /admin/sync/status.
  engine.onStatusChange((change) => {
    wsClient.emitEvent("sync.status", toSyncStatusPayload(change));
  });

  // Source / auth command handlers are factored out so they can be reused
  // (and unit-tested). They cover source.descriptors / source.discover /
  // source.validate-param / source.add / sources.snapshot.request
  // and auth.begin / auth.cancel / auth.code.
  const sourceHandlers = createSourceWsHandlers({
    sourceManager: manager,
    gateway,
    emitEvent: (type, payload) => wsClient.emitEvent(type, payload),
    onSourcesChanged: () => {
      void engine.refreshAllSourceMeta();
      // Same per-source metadata pushes the sources.snapshot handler fires:
      // a source added mid-session must contribute its URL canonicalizer,
      // score prior, URL graph roles, and self-identity hook immediately,
      // not on next reconnect.
      engine.pushLinkDeclarations(manager.getKnownUrlPatterns()).catch((err) => {
        log.warn(`pushLinkDeclarations failed: ${toErrorMessage(err)}`);
      });
      engine.pushSourcePriorDefaults().catch((err) => {
        log.warn(`pushSourcePriorDefaults failed: ${toErrorMessage(err)}`);
      });
      engine.pushSelfIdentitySources().catch((err) => {
        log.warn(`pushSelfIdentitySources failed: ${toErrorMessage(err)}`);
      });
    },
  });

  // Commands this collector answers itself, registered through the same typed
  // table the source/auth handlers use: a handler whose answer disagrees with
  // the command's response schema is a compile error rather than a runtime
  // rejection the gateway reports as a failure on a command that succeeded.
  const engineCommands = createCommandDispatch();

  const doctorVitals = new CollectorDoctorVitals();
  doctorVitals.start();
  const collectorDoctor = new CollectorDoctor({
    configDir,
    getIdentity: () => wsClient.getIdentity(),
    getConfigStatus: () => configStatus,
    getSourceStatuses: () => engine.getStatuses(),
    getReadAccessSources: () => {
      const enabled = new Set(
        engine
          .getStatuses()
          .filter((source) => source.state !== "disabled")
          .map((source) => source.sourceId),
      );
      return engine
        .registeredSources()
        .filter(({ source }) => enabled.has(source.id))
        .map(({ source }) => ({ sourceId: source.id, instance: source.instance }));
    },
    getProcessVitals: () => doctorVitals.snapshot(),
    emitResult: (payload) => wsClient.emitEvent("device.doctor.result", payload),
  });

  engineCommands.register("device.doctor", ({ runId }) => collectorDoctor.start(runId));

  engineCommands.register("source.sync", (payload) => handleSourceSyncCommand(engine, payload));

  // Known bug: #98 — the reply carries no cursor, so `sources debug` never shows one.
  engineCommands.register("source.debug", (payload) => ({
    status: engine.getStatuses().find((s) => s.sourceId === payload.sourceId) ?? null,
  }));

  engineCommands.register("sources.snapshot", async ({ sources }) => {
    // Gateway is authoritative for the source registry. Reconcile
    // local state to match: register new, unregister removed, toggle
    // enabled. Idempotent — safe to receive on every reconnect.
    try {
      await manager.applySourcesSnapshot(sources);
      await engine.refreshAllSourceMeta();
      // Providers are now registered. Push per-source URL canonicalizers so
      // the gateway can canonicalize URLs at ingest + lookup time without
      // holding source-specific knowledge itself. Fire-and-forget — the push
      // includes a recompute-source-urls call that re-derives stored URLs;
      // failing here would just delay canonicalization to the next boot.
      log.info(`sources.snapshot: publishing atomic link declarations (sources=${sources.length})`);
      engine.pushLinkDeclarations(manager.getKnownUrlPatterns()).catch((err) => {
        log.warn(`pushLinkDeclarations failed: ${toErrorMessage(err)}`);
      });
      // Per-source-type score priors, so the gateway can apply
      // source-advertised defaults without source-specific knowledge. The
      // gateway falls back to user-config-only priors if this fails.
      engine.pushSourcePriorDefaults().catch((err) => {
        log.warn(`pushSourcePriorDefaults failed: ${toErrorMessage(err)}`);
      });
      // The independent traversal-hub, fallback-representation, and
      // reference-only URL roles. Until the complete declaration arrives, the
      // gateway postpones URL target repair; traversal keeps hub edges visible.
      // Per-source self-identity hooks, so the gateway's self-detection pass
      // can pair a synced account to the self LID alias the source emits
      // without source-name branching. A hook that doesn't make it across just
      // contributes no alias.
      engine.pushSelfIdentitySources().catch((err) => {
        log.warn(`pushSelfIdentitySources failed: ${toErrorMessage(err)}`);
      });
      // The url-id patterns of every KNOWN source type, not just the added
      // ones, so the link-extraction keep-gate retains a link to a
      // not-yet-added source and resolves it once that source arrives.
      // The gateway falls back to the registered-pattern set on failure.
      // The web hosts owned by every KNOWN source type, so browser capture
      // skips any visited host a dedicated source already ingests. The
      // gateway falls back to an empty set — skip nothing extra — on failure.
      manager.pushOwnedWebDomains().catch((err) => {
        log.warn(`pushOwnedWebDomains failed: ${toErrorMessage(err)}`);
      });
      // Push what every KNOWN source type's documents can be asked about, so
      // subscription compilation can turn a natural-language watch condition
      // into a deterministic document predicate. Fire-and-forget; the gateway
      // keeps the set it persisted on the last successful push.
      manager.pushDocumentEventProfiles().catch((err) => {
        log.warn(`pushDocumentEventProfiles failed: ${toErrorMessage(err)}`);
      });
      // External widget-vendor origins of every KNOWN `link-widget` source, so
      // the gateway can fold them into the portal CSP and a hosted widget can
      // load its SDK + iframe. The gateway keeps a strictly self-hosted
      // CSP on failure.
      manager.pushWidgetOrigins().catch((err) => {
        log.warn(`pushWidgetOrigins failed: ${toErrorMessage(err)}`);
      });
      // Provider-owned hosted-widget renderer modules; the portal imports
      // these by opaque widget kind, keeping vendor SDK details inside
      // provider packages.
      manager.pushWidgetRenderers().catch((err) => {
        log.warn(`pushWidgetRenderers failed: ${toErrorMessage(err)}`);
      });
      // Every structured source's analytics table schema, so the gateway's
      // catalog reflects the running collector's descriptors instead of the
      // schema last written during an ingest. Without it the catalog
      // simply waits for that source's next ingest.
      engine.pushAnalyticsSchemas().catch((err) => {
        log.warn(`pushAnalyticsSchemas failed: ${toErrorMessage(err)}`);
      });
      return { ok: true, applied: sources.length };
    } catch (err) {
      log.error(`applySourcesSnapshot failed: ${toErrorMessage(err)}`);
      return { ok: false, error: toErrorMessage(err) };
    }
  });

  engineCommands.register("source.added", async ({ source }) => {
    // The payload carries the full source record — merge it into the local
    // set so the collector instantiates and starts syncing without waiting
    // for a restart. Merge, not replace: this is one record, not the
    // device's full source list, so treating it as an authoritative
    // snapshot would unregister every other source this collector hosts.
    // Idempotent: if the local `source.add` handler already registered this
    // key, the diff is empty.
    if (!source) return { ok: true, applied: false };
    log.info(`Gateway → collector source.added: ${source.id}`);
    try {
      await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: true };
    } catch (err) {
      log.error(`source.added handler failed for ${source.id}: ${toErrorMessage(err)}`);
      return { ok: false, error: toErrorMessage(err) };
    }
  });

  engineCommands.register("source.removed", async ({ sourceId }) => {
    log.info(`Gateway → collector source.removed: ${sourceId}`);
    try {
      const { deleted, failures } = await manager.removeSources([sourceId]);
      log.info(`Removed ${sourceId}: ${deleted} documents deleted from the gateway`);
      return buildSourceRemovedAck({ sourceId, failures });
    } catch (err) {
      log.error(`source.removed handler failed for ${sourceId}: ${toErrorMessage(err)}`);
      return { ok: false, error: toErrorMessage(err) };
    }
  });

  registerSourceUpdatedCommand(engineCommands, manager);

  // Set once shutdown begins; declared before the self-update hand-over,
  // which reads it.
  let shuttingDown = false;

  // The fleet update. The gateway names a version; the CLI beside this daemon
  // does the work and refuses a version its own remote has no tag for. This
  // process then asks its own service unit for a restart onto the new build,
  // or, when it runs under no unit it can identify, exits non-zero so its
  // supervisor brings it back — a clean exit would park the unit instead. Its
  // next hello is what tells the gateway the update landed.
  registerSelfUpdateCommand(engineCommands, {
    updater: createCliUpdater(),
    currentVersion: COLLECTOR_VERSION,
    acquireLock: () =>
      acquireUpdateLock(configDir, {
        owner: "collector self-update",
        currentStep: "starting collector self-update",
      }),
    emitResult: (payload) => wsClient.emitEvent("device.update.result", payload),
    handOver: () => {
      void handOverToServiceManager({
        isShuttingDown: () => shuttingDown,
        exit: () => {
          void (async () => {
            // stderr is a pipe under a service manager and `process.exit` does
            // not flush it, so the hand-over's log line would be lost without this.
            await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
            process.exit(1);
          })();
        },
      });
    },
  });

  // Handle gateway → collector commands (Phase 2 source management bridge).
  wsClient.onCommand(
    createGatewayCommandHandler(requireSourceContract, [sourceHandlers, engineCommands]),
  );

  wsClient.connect();

  // A device revoked while this collector is running loses its socket and
  // every HTTP call at once, and the WS reconnect cannot tell a revoked
  // credential from an unreachable gateway — both are just a closed socket.
  // Probe over HTTP, where the gateway answers with a status code, and only
  // while the socket is down so a healthy collector never adds traffic.
  let probing = false;
  let settlingPairing = false;
  const pairingWatchdog = setInterval(() => {
    if (wsClient.isAuthenticated() || probing || settlingPairing) return;
    probing = true;
    void (async () => {
      try {
        const verdict = classifyCollectorAuth({
          // This credential authenticated on the way here — `main` only gets
          // a token from a probe the gateway accepted or a fresh self-pair.
          status: await probeTokenStatus(gatewayUrl, token),
          everAuthenticated: true,
        });
        if (verdict !== "needs-pairing" || settlingPairing) return;
        settlingPairing = true;
        clearInterval(pairingWatchdog);
        wsClient.disconnect();
        const drained = await engine
          .stopSyncLoopAndDrain(SHUTDOWN_DRAIN_MS)
          .catch(() => ({ inflight: 0, timedOut: false }));
        if (drained.inflight > 0) {
          log.info(
            `Drained ${drained.inflight} in-flight sync${drained.inflight === 1 ? "" : "s"}${drained.timedOut ? " (hit the drain cap)" : ""}`,
          );
        }
        // Take the same route a fresh boot would: on the gateway host the
        // bootstrap admin token is still there and reclaims the revoked row,
        // so the two paths cannot disagree about what a revoke means here.
        const recovered = await resolveCollectorToken(gatewayUrl, configDir).catch(
          () => ({ outcome: "needs-pairing" }) as CollectorTokenResolution,
        );
        if (recovered.outcome === "token") {
          log.info("Re-paired with the gateway — restarting to pick up the new credential");
          await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
          // Non-zero so the service manager restarts us: every client below
          // holds the credential that has just been replaced.
          process.exit(1);
        }
        await halt();
      } finally {
        probing = false;
      }
    })();
  }, PAIRING_WATCHDOG_INTERVAL_MS);
  pairingWatchdog.unref();

  // Now kick off the initial sync. Fire-and-forget — startSyncLoop awaits
  // Promise.allSettled over every source's initial sync, which can run for
  // a long time on large backlogs. Letting main() await would block all the
  // post-init wiring below (config watcher, SIGINT handlers).
  engine.startSyncLoop(manager.getConfig()).catch((err) => {
    log.error(`Initial sync failed, will retry on next interval: ${toErrorMessage(err)}`);
  });

  // Config is driven entirely by the gateway now — live updates arrive via
  // the `config.changed` WS event above. No local file to watch.

  // Graceful shutdown — await in-flight syncs (cursor writes, status
  // emits) before exiting. Without the drain, Ctrl-C during a sync
  // could leave a successfully-committed page un-cursored, so the next
  // collector start re-fetches the same page. 30s wallclock cap keeps
  // a hung sync from blocking SIGTERM forever.
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down collector...");
    try {
      const { inflight, timedOut } = await engine.stopSyncLoopAndDrain(SHUTDOWN_DRAIN_MS);
      if (inflight > 0) {
        log.info(
          `Drained ${inflight} in-flight sync${inflight === 1 ? "" : "s"}${timedOut ? " (hit the drain cap)" : ""}`,
        );
      }
    } catch (err) {
      log.error(`stopSyncLoopAndDrain threw: ${toErrorMessage(err)}`);
    }
    clearInterval(pairingWatchdog);
    doctorVitals.dispose();
    try {
      wsClient.disconnect();
    } catch (err) {
      log.error(`wsClient.disconnect threw: ${toErrorMessage(err)}`);
    }
    // Kill any in-flight auth subprocesses (`tsx`
    // children spawned by `auth.begin`) before exiting. Without
    // this, a SIGINT during an OAuth dance leaks orphan processes
    // that survive the parent and keep `:3000-3003` (callback
    // server) bound, blocking the next launch.
    try {
      await sourceHandlers.shutdown();
    } catch (err) {
      log.error(`sourceHandlers.shutdown threw: ${toErrorMessage(err)}`);
    }
    log.info("Collector stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

// Narrow safety net: keep the collector alive ONLY through the known
// Baileys `useMultiFileAuthState` ENOENT race — every other error
// escalates so the supervisor can restart the process. The predicate
// + its rationale live in `baileys-enoent-filter.ts` so the truth
// table is unit-testable on its own (collector is a daemon entry
// point, not a class — testing the predicate against a fixture set
// of Error shapes is cheaper than spinning up the whole process).

process.on("unhandledRejection", (reason) => {
  if (isBaileysAuthEnoent(reason)) {
    log.warn(`Suppressing benign Baileys auth-state ENOENT race: ${toErrorMessage(reason)}`);
    return;
  }
  log.error(`Unhandled rejection: ${toErrorMessage(reason)}`);
  // Rejections don't crash the runtime by default — surface as a fatal
  // signal so the supervisor restarts us instead of leaving the
  // collector in an undefined state.
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  if (isBaileysAuthEnoent(err)) {
    log.warn(`Suppressing benign Baileys auth-state ENOENT race: ${toErrorMessage(err)}`);
    return;
  }
  log.error(`Uncaught exception: ${toErrorMessage(err)}`);
  process.exit(1);
});

// Only launch the daemon when run as the entrypoint (`tsx src/main.ts`),
// not when a unit test imports this module to exercise an exported helper
// like `resolveGatewayUrl`. tsx sets argv[1] to the resolved script path.
const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isEntrypoint) {
  main().catch((err) => {
    log.error(`Fatal error: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}

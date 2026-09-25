// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import {
  judgeCaptureUrl,
  normalizeCaptureDomain,
  type WebCapturePolicy,
} from "@omnesis/provider-web/capture-policy";
import {
  CapturePolicyClient,
  CapturePolicyError,
  PushClient,
  buildWebPageDocument,
  buildPageVisit,
  type FetchLike,
  type FetchLikeResponse,
  clearPushHealth,
  clearPushObservability,
  clearPushQueue,
  clearPushServerState,
  clearPushDataLoss,
  normalizeGatewayUrl,
  pair,
  PairingOutcomeUnknownError,
  readGatewayVersion,
} from "../push/index.js";
import { hashText } from "../capture/content-hash.js";
import {
  clearCachedPolicy,
  policyIsStale,
  readCachedPolicy,
  writeCachedPolicy,
} from "../capture/policy.js";
import { PAIRING_ATTEMPT_KEY, resolvePairingAttempt } from "./pairing-attempt.js";
import {
  chromeLocalStore,
  clearConfig,
  getOrCreateInstallId,
  hasExactWebScope,
  type ExtensionConfig,
  loadConfig,
  migrateLegacyConfig,
  loadProfileLabel,
  saveCapturePermissionState,
  saveConfig,
  saveGatewayVersion,
  saveProfileLabel,
} from "./storage.js";
import { hasCapturePermission, revokeCapturePermission } from "./host-permission.js";
import { composeStatus, badgeFor } from "./status.js";
import {
  PERIODIC_DRAIN_ALARM,
  PERMISSION_RECONCILE_ALARM,
  RETRY_DRAIN_ALARM,
} from "./alarm-names.js";
import { CAPTURE_HANDOFF_FAILURE_KEY, CAPTURE_HANDOFF_OVERFLOW_KEY } from "./messages.js";
import { routeBackgroundMessage } from "./message-router.js";
import {
  capturePairingId,
  clearPendingHandoffs,
  pendingHandoffKeys,
  readPendingHandoffs,
} from "./handoff-storage.js";
import { CapturePermissionCoordinator } from "./permission-coordinator.js";
import { hasCaptureAccess, syncCaptureContentScript } from "./content-registration.js";
import { BadgeRefreshCoordinator } from "./badge-refresh.js";
import type {
  CaptureEligibilityResponse,
  CapturePolicySnapshot,
  ContentToSwMessage,
  PopupToSwMessage,
  CaptureAck,
  OptionsToSwMessage,
} from "./messages.js";

/**
 * MV3 service-worker entry — the extension's background and single owner of all
 * network + queue state.
 *
 * MV3 service workers are ephemeral: the browser evicts them within seconds of
 * idle and re-spawns them on an event. So this file holds NO authoritative
 * state — every wake rebuilds the {@link PushClient} from the durable config +
 * queue. The drain cadence is driven by `chrome.alarms` (which survive
 * eviction; `setTimeout`/`setInterval` do NOT), with a self-scheduled earlier
 * wake when the queue is backing off.
 *
 * The capture engine (the content script) does no network and never touches the
 * queue: it runs the capture state machine and messages this worker with each
 * confirmed capture (which we enqueue) and with eligibility probes (which we
 * answer from the browser's copy of the gateway-owned capture policy, so every
 * paired browser applies the same exclusions and the extension never captures
 * its own Omnesis portal).
 */

/** Baseline periodic drain. Chrome clamps alarm periods to ≥1 minute. */
const PERIOD_MINUTES = 1;
/**
 * How stale the last liveness check may be before an idle drain pass re-probes
 * the token + gateway. The drain alarm fires every minute, but an idle pass
 * (empty queue) does no network on its own — without this the token is never
 * re-validated while nothing is being captured, so a revoked token stays
 * invisible. Fifteen minutes bounds "how long a dead token can look healthy"
 * while keeping the empty POST cheap (one per interval, not one per tick).
 */
const IDLE_PROBE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * chrome.storage.local is a shared read/modify/write store. Every capture,
 * popup check, startup wake, and alarm therefore passes through one serial
 * lane: concurrent clients must never replace a queue snapshot another client
 * has just appended to.
 */
let queueWork: Promise<void> = Promise.resolve();
function serializeQueueWork<T>(work: () => Promise<T>): Promise<T> {
  const result = queueWork.then(work, work);
  queueWork = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Probes are separate so a slow liveness request never blocks durable enqueue. */
let probeWork: Promise<void> = Promise.resolve();
let clientGeneration = 0;
const workerSessionId = crypto.randomUUID();
function serializeProbeWork<T>(work: () => Promise<T>): Promise<T> {
  const result = probeWork.then(work, work);
  probeWork = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Pair-code redemption + config commit is one cross-options-tab transaction. */
let pairingWork: Promise<void> = Promise.resolve();
function serializePairingWork<T>(work: () => Promise<T>): Promise<T> {
  const result = pairingWork.then(work, work);
  pairingWork = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * A `FetchLike` over the real `fetch` that omits the body for GET requests —
 * the push module's `FetchLike` types `body` as a required string, but a real
 * GET (the capture-policy read) must not carry one.
 */
const realFetch: FetchLike = (input, init) => {
  const hasBody = init.method !== "GET" && init.method !== "HEAD" && init.body !== "";
  return fetch(input, {
    method: init.method,
    headers: init.headers,
    ...(hasBody ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.redirect ? { redirect: init.redirect } : {}),
  }) as unknown as Promise<FetchLikeResponse>;
};

async function buildClient(): Promise<PushClient | null> {
  const config = await loadConfig();
  if (!config || !hasExactWebScope(config)) return null;
  clientGeneration += 1;
  return new PushClient({
    gatewayUrl: config.gatewayUrl,
    token: config.token,
    fetch: realFetch,
    store: chromeLocalStore,
    // One request per event bounds how long network work can delay a fresh
    // capture acknowledgement on the shared durable-queue lane.
    batchSize: 1,
    observationSessionId: workerSessionId,
    observationGeneration: clientGeneration,
  });
}

/**
 * The capture settings live on the gateway; this worker keeps the browser's
 * copy of them under a durable key and refreshes it when stale, on every popup
 * check, and from the response of each of its own edits. A browser holding no
 * copy captures nothing: the policy is what says which pages may leave.
 */
let policyRefresh: { pairing: string; promise: Promise<WebCapturePolicy | null> } | null = null;

/** Keys holding a browser-local exclusion list and pause from builds that kept them locally. */
const LEGACY_DENYLIST_KEY = "omnesis.capture.denylist.v1";
const LEGACY_PAUSE_KEY = "omnesis.capture.pause.v1";

function policyClient(config: ExtensionConfig): CapturePolicyClient {
  return new CapturePolicyClient(config.gatewayUrl, config.token, realFetch);
}

async function requirePairedConfig(): Promise<ExtensionConfig> {
  const config = await loadConfig();
  if (!config || !hasExactWebScope(config)) {
    throw new Error("Pair this browser before changing its capture settings");
  }
  return config;
}

function gatewayHostOf(config: ExtensionConfig): string {
  try {
    return new URL(config.gatewayUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * The policy in force. A copy answers at once even when stale — a refresh then
 * runs in the background so a slow or unreachable gateway never holds up a
 * page probe or a capture — and a failed refresh keeps the last copy
 * governing. Only a browser with no copy, or a caller asking for a fresh read,
 * waits on the gateway; with no copy there is no policy and the caller must
 * refuse to capture.
 */
async function currentPolicy(opts: { refresh?: boolean } = {}): Promise<WebCapturePolicy | null> {
  const config = await loadConfig();
  if (!config || !hasExactWebScope(config)) return null;
  const cached = await readCachedPolicy(chromeLocalStore);
  if (cached && !opts.refresh && !policyIsStale(cached, Date.now())) return cached.policy;
  const refresh = refreshPolicy(config, cached?.policy ?? null);
  if (cached && !opts.refresh) {
    void refresh;
    return cached.policy;
  }
  return refresh;
}

/**
 * One gateway read at a time, bound to the pairing that asked for it: a copy
 * fetched for one gateway is never written under a pairing to another, so a
 * re-pair during a refresh cannot leave the new pairing governed by the old
 * gateway's settings.
 */
function refreshPolicy(
  config: ExtensionConfig,
  fallback: WebCapturePolicy | null,
): Promise<WebCapturePolicy | null> {
  const pairing = `${config.gatewayUrl}\0${config.deviceId}`;
  if (policyRefresh?.pairing === pairing) return policyRefresh.promise;
  const promise = (async () => {
    try {
      const policy = await policyClient(config).read();
      const current = await loadConfig();
      if (!current || `${current.gatewayUrl}\0${current.deviceId}` !== pairing) return fallback;
      await writeCachedPolicy(chromeLocalStore, policy, Date.now());
      return policy;
    } catch {
      return fallback;
    } finally {
      if (policyRefresh?.pairing === pairing) policyRefresh = null;
    }
  })();
  policyRefresh = { pairing, promise };
  return promise;
}

/** Replace the copy with the policy a gateway edit just returned. */
function adoptPolicy(policy: WebCapturePolicy): Promise<void> {
  return writeCachedPolicy(chromeLocalStore, policy, Date.now());
}

/** Answer a page's "may I capture this URL?" probe from the policy. */
async function judgeEligibility(url: string): Promise<CaptureEligibilityResponse> {
  const config = await loadConfig();
  if (!config || !hasExactWebScope(config)) {
    return { eligible: false, reason: "unpaired", skipPasswordForms: true };
  }
  const policy = await currentPolicy();
  if (!policy) return { eligible: false, reason: "no-policy", skipPasswordForms: true };
  const verdict = judgeCaptureUrl(policy, url, {
    gatewayHost: gatewayHostOf(config),
    now: Date.now(),
  });
  const skipPasswordForms = policy.rules.skipPasswordForms;
  return verdict.allowed
    ? { eligible: true, skipPasswordForms }
    : { eligible: false, reason: verdict.reason, skipPasswordForms };
}

/** The popup's and options page's view of the shared settings. */
async function readPolicySnapshot(): Promise<CapturePolicySnapshot> {
  const policy = await currentPolicy();
  const cached = await readCachedPolicy(chromeLocalStore);
  return { policy, fetchedAt: cached?.fetchedAt ?? null };
}

/**
 * Hand a browser-local exclusion list to the gateway, once, then forget the
 * local keys; a local pause is simply dropped, since the shared pause is set
 * from the popup. The keys stay until a pairing exists to hand the list to.
 * A domain the gateway refuses outright is skipped; a gateway that cannot be
 * reached leaves the keys in place for the next worker start.
 */
async function migrateLegacyCaptureSettings(): Promise<void> {
  const raw = await chrome.storage.local.get([LEGACY_DENYLIST_KEY, LEGACY_PAUSE_KEY]);
  if (!(LEGACY_DENYLIST_KEY in raw) && !(LEGACY_PAUSE_KEY in raw)) return;
  const config = await loadConfig();
  if (!config || !hasExactWebScope(config)) return;
  const client = policyClient(config);
  let policy: WebCapturePolicy | null = null;
  for (const domain of legacyDenylist(raw[LEGACY_DENYLIST_KEY])) {
    try {
      policy = (await client.addExcludedDomain(domain, false)).policy;
    } catch (error) {
      if (error instanceof CapturePolicyError && error.status < 500) continue;
      throw error;
    }
  }
  if (policy) await adoptPolicy(policy);
  await chrome.storage.local.remove([LEGACY_DENYLIST_KEY, LEGACY_PAUSE_KEY]);
}

function legacyDenylist(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .filter((entry): entry is string => typeof entry === "string")
          .map(normalizeCaptureDomain)
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Recompute the toolbar badge from the one composed status (shared with the
 * popup), so the badge reflects error / paused / offline / pending / clean
 * without the popup being open. Cheap; called after every drain, capture, and
 * pause change. Best-effort — never throws into a caller.
 */
const badgeRefresh = new BadgeRefreshCoordinator();
function refreshBadge(): Promise<void> {
  return badgeRefresh.run(async () => {
    try {
      const config = await loadConfig();
      const client = await buildClient();
      const status = await composeStatus({
        config,
        client,
        hostPermissionOk: !config || (await hasCaptureAccess()),
        store: chromeLocalStore,
        now: Date.now(),
      });
      const badge = badgeFor(status);
      await chrome.action.setBadgeText({ text: badge.text });
      await chrome.action.setBadgeBackgroundColor({ color: badge.color });
      await chrome.action.setTitle({ title: badge.title });
    } catch {
      // The badge is a convenience; a failure here must never break capture/drain.
    }
  });
}

async function drainWork(skipIdleProbe = false): Promise<boolean> {
  const client = await buildClient();
  if (!client) return false;
  const result = await client.drain();
  // If items are backing off sooner than the next periodic tick, schedule an
  // earlier one-shot wake so we don't wait the full period to retry.
  const readyAgain = result.nextEligibleAt !== null && result.nextEligibleAt <= Date.now();
  if (result.nextEligibleAt !== null && !readyAgain) {
    const delayMs = Math.max(0, result.nextEligibleAt - Date.now());
    const periodMs = PERIOD_MINUTES * 60 * 1000;
    if (delayMs < periodMs) {
      chrome.alarms.create(RETRY_DRAIN_ALARM, { when: result.nextEligibleAt });
    }
  }
  // An idle pass (nothing to deliver) produces no auth/connectivity signal on
  // its own, so a revoked token or dead gateway would never surface while the
  // queue is empty. Probe on a bounded cadence to keep the health snapshot
  // honest even when nothing is being captured. A pass that did real work
  // already refreshed those snapshots, so skip the probe then.
  const idle =
    result.delivered === 0 &&
    result.retained === 0 &&
    result.dropped === 0 &&
    result.suppressed === 0;
  if (idle && !skipIdleProbe) {
    await client.probeAuthIfStale(IDLE_PROBE_INTERVAL_MS);
  }
  // A page refused as deleted for good means the policy has moved on since
  // this copy was read; take the new copy so the page is not captured again.
  if (result.suppressed > 0) await currentPolicy({ refresh: true });
  // The drain (and any probe) refreshed health / connectivity / recent / queue
  // depth — reflect them on the badge so it's current without the popup open.
  await refreshBadge();
  return readyAgain;
}

function drainOnce(): Promise<void> {
  const pass = serializeQueueWork(drainWork);
  return pass.then(
    (readyAgain) => {
      // Chrome alarms have a 30-second minimum in packed extensions. Release
      // the queue lane between requests, then chain another bounded pass for a
      // healthy ready backlog; reserve alarms for actual future backoff.
      if (readyAgain) void drainOnce();
    },
    () => {
      // Alarm/startup/message callbacks are fire-and-forget. The durable queue
      // remains intact and the next alarm retries; never leak an unhandled
      // rejection that can terminate an MV3 worker event.
    },
  );
}

/** Enqueue a confirmed capture's two planes, then kick a drain. */
async function handleCapture(
  message: Extract<ContentToSwMessage, { type: "capture" }>,
): Promise<CaptureAck> {
  return serializeQueueWork(async () => {
    const finish = async (ack: CaptureAck): Promise<CaptureAck> => {
      if (message.handoffKey) await chrome.storage.local.remove(message.handoffKey);
      return ack;
    };
    if (!(await hasCapturePermission())) return finish({ ok: true, accepted: false });
    const config = await loadConfig();
    if (message.handoffKey) {
      const currentPairingId = config ? await capturePairingId(config) : null;
      if (!currentPairingId || message.pairingId !== currentPairingId) {
        return finish({ ok: true, accepted: false });
      }
    }
    const client = await buildClient();
    if (!client || !config) return finish({ ok: true, accepted: false });
    const browserProfile = {
      deviceId: config.deviceId,
      label: await loadProfileLabel(),
    };

    // If Omnesis has removed or paused the Browser source, stop enqueuing new
    // captures — there's nothing to push them to. The queue retains a probe item
    // that re-attempts on a slow cadence, so a later re-enable (re-pair / portal
    // resume) is detected automatically and capture resumes; until then we don't
    // grow the durable upload queue with work the gateway will only reject.
    if ((await client.getServerState()) && (await client.queueDepth()) > 0) {
      return finish({ ok: true, accepted: false });
    }

    // The gateway-owned policy decides what may leave this browser at the
    // enqueue seam, and nothing leaves without a copy of it. A pause stops
    // *capture*, not *drain*: anything already queued keeps flushing to the
    // gateway until the queue reaches zero.
    const policy = await currentPolicy();
    if (!policy) return finish({ ok: true, accepted: false });
    const { emission } = message;
    try {
      const emissionUrl = new URL(emission.normalizedUrl);
      if (emissionUrl.username || emissionUrl.password) {
        return finish({ ok: true, accepted: false });
      }
    } catch {
      return finish({ ok: true, accepted: false });
    }
    const verdict = judgeCaptureUrl(policy, emission.normalizedUrl, {
      gatewayHost: gatewayHostOf(config),
      now: Date.now(),
      externalId: await hashText(emission.normalizedUrl),
    });
    if (!verdict.allowed) return finish({ ok: true, accepted: false });

    // Content plane: enqueue the document only when the text content changed.
    if (emission.contentChanged) {
      await client.enqueueDocument(
        await buildWebPageDocument({
          normalizedUrl: emission.normalizedUrl,
          title: emission.title,
          text: emission.text,
          contentHash: emission.contentHash,
          visitedAt: emission.visitedAt,
          browserProfile,
        }),
      );
    }

    // Analytics plane: a `page_visits` row per dwell-confirmed visit only (a
    // post-mutation re-extract is not a new visit).
    if (emission.kind === "visit") {
      await client.enqueueVisit(
        buildPageVisit({
          normalizedUrl: emission.normalizedUrl,
          title: emission.title,
          visitedAt: emission.visitedAt,
          dwellMs: emission.dwellMs,
          browserProfile,
        }),
      );
    }

    return finish({ ok: true, accepted: true });
  });
}

/** Recover captures persisted by tabs before their worker handoff was acknowledged. */
async function recoverPendingHandoffs(): Promise<void> {
  const config = await loadConfig();
  const pairingId = config ? await capturePairingId(config) : null;
  const pending = await readPendingHandoffs(chrome.storage.local);
  for (const item of pending) {
    try {
      if (!item.record || !pairingId || item.record.pairingId !== pairingId) {
        await chrome.storage.local.remove(item.key);
        continue;
      }
      await handleCapture({
        type: "capture",
        emission: item.record.emission,
        handoffKey: item.key,
        pairingId: item.record.pairingId,
      });
    } catch {
      // One damaged/unwritable record must not prevent the remaining outbox or
      // normal queue drain from making progress during this wake.
    }
  }
  if ((await pendingHandoffKeys(chrome.storage.local)).length === 0) {
    await chrome.storage.local.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
  }
}

function ensureDrainAlarm(): void {
  chrome.alarms.create(PERIODIC_DRAIN_ALARM, { periodInMinutes: PERIOD_MINUTES });
}

/**
 * Apply a popup pause command on the gateway, adopt the policy it returns, and
 * refresh the badge. The round trip runs on the queue lane so the
 * acknowledgement is a real boundary: no capture racing it is enqueued once
 * the pause is confirmed. A timed pause needs no alarm — the policy carries its
 * deadline and every reader compares it with the clock.
 */
async function handlePauseMessage(
  msg: Extract<PopupToSwMessage, { type: "resume" | "set-pause" }>,
): Promise<void> {
  await serializeQueueWork(async () => {
    const client = policyClient(await requirePairedConfig());
    const policy =
      msg.type === "set-pause" ? await client.setPause(msg.until) : await client.clearPause();
    await adoptPolicy(policy);
    await refreshBadge();
  });
}

/**
 * Run a proactive liveness/auth probe followed by a drain, then refresh the
 * badge. Triggered by the popup opening (`check-now`) so the user gets an
 * up-to-the-second verdict — a red badge + "re-pair" warning if the token is
 * dead — rather than whatever the last idle probe happened to record. The probe
 * is forced (not throttled): the user explicitly asked "is this working right
 * now?" by opening the popup.
 */
async function handleCheckNow(): Promise<void> {
  // The permission event can race worker startup or be missed while the worker
  // is suspended. Reconcile explicitly so Repair has one service-worker-owned
  // path for permission state and dynamic content-script registration.
  await reconcilePermissionWork(permissionCoordinator.reconcile());
  // Reachability has no queue mutation and must never sit ahead of a capture
  // waiting to become durable. Build the client inside the probe lane so a
  // pairing transition queued ahead of us cannot leave this check using an old
  // token after the transition commits.
  await serializeProbeWork(async () => {
    const client = await buildClient();
    if (client) await client.probeAuth();
  });
  await refreshGatewayVersion();
  await currentPolicy({ refresh: true });
  await serializeQueueWork(async () => {
    await drainWork(true);
  });
}

/**
 * Re-read the gateway's version from its health check and record it beside the
 * pairing when it changed, so the popup can say when the gateway has fallen
 * behind this extension (or moved ahead of it).
 */
async function refreshGatewayVersion(): Promise<void> {
  const config = await loadConfig();
  if (!config) return;
  const version = await readGatewayVersion(config.gatewayUrl, realFetch);
  if (version === null || version === config.gatewayVersion) return;
  await serializePairingWork(async () => {
    try {
      await saveGatewayVersion(config.gatewayUrl, version);
    } catch {
      // Informational only; the next check-now records it.
    }
  });
}

/**
 * Change pairing state in the same serialized ownership domain as queue
 * mutation. This prevents an in-flight old-gateway drain from restoring a
 * queue after unpair, or from leaking old queued pages into a new gateway.
 */
function handlePairingState(
  msg: Extract<
    OptionsToSwMessage,
    { type: "pair-browser" | "unpair" | "revoke-capture-access" | "set-profile-label" }
  >,
): Promise<{ warning?: string } | void> {
  return serializePairingWork(async () => {
    if (msg.type === "revoke-capture-access") {
      if (await loadConfig()) throw new Error("Unpair before removing HTTPS page access");
      return releaseCapturePermission();
    }
    if (msg.type === "set-profile-label") {
      if (!(await loadConfig())) throw new Error("Pair this browser before naming its profile");
      await saveProfileLabel(msg.profileLabel);
      return;
    }
    let config: ExtensionConfig | null = null;
    let profileLabel: string | undefined;
    let permissionWarning = false;
    if (msg.type === "pair-browser") {
      // Reconcile before redeeming the one-time pairing code. This both checks
      // the authoritative host grant and installs the dynamic capture script;
      // the Options page never races this registration from another context.
      if (!(await reconcilePermissionWork(permissionCoordinator.reconcile()))) {
        throw new Error("HTTPS page access is missing. Grant page access and try pairing again.");
      }
      const gatewayUrl = normalizeGatewayUrl(msg.gatewayUrl);
      profileLabel = msg.profileLabel ?? (await loadProfileLabel()) ?? undefined;
      if (!profileLabel) throw new Error("Enter this Chrome profile's name before pairing");
      // A re-pair names the row this extension was paired as before, so the
      // gateway adopts it even if the operator renamed it.
      const previous = await loadConfig();
      // One idempotency key per (gateway, code) attempt, kept across a timeout
      // or a worker eviction so the retry replays the first redemption instead
      // of finding the code already spent.
      const attempt = await resolvePairingAttempt(
        (await chrome.storage.local.get(PAIRING_ATTEMPT_KEY))[PAIRING_ATTEMPT_KEY],
        { gatewayUrl, pairingCode: msg.pairingCode, now: Date.now() },
        hashText,
      );
      await chrome.storage.local.set({ [PAIRING_ATTEMPT_KEY]: JSON.stringify(attempt) });
      let result;
      try {
        result = await pair(gatewayUrl, msg.pairingCode, realFetch, profileLabel, {
          installId: await getOrCreateInstallId(),
          previousDeviceId: previous?.deviceId,
          // The manifest version is the product version: the store-package
          // contract refuses to build unless manifest, package and release
          // contract all agree.
          version: chrome.runtime.getManifest().version,
          idempotencyKey: attempt.key,
        });
      } catch (error) {
        // Only a request the gateway never answered leaves the outcome unknown;
        // an HTTP verdict ends the attempt, and the next submit is a fresh one.
        if (!(error instanceof PairingOutcomeUnknownError)) {
          await chrome.storage.local.remove(PAIRING_ATTEMPT_KEY);
        }
        throw error;
      }
      await chrome.storage.local.remove(PAIRING_ATTEMPT_KEY);
      config = {
        gatewayUrl,
        token: result.token,
        scopes: result.scopes,
        deviceId: result.device.id,
        pairedAt: Date.now(),
        ...(result.gatewayVersion ? { gatewayVersion: result.gatewayVersion } : {}),
      };
      // Keep lock acquisition ordered: permission reconciliation may clear the
      // queue, so it must finish before the probe and queue commit lanes.
      try {
        permissionWarning = !(await reconcilePermissionWork(permissionCoordinator.reconcile()));
      } catch {
        // The retry alarm will reconcile uncertainty. Preserve the credential
        // that the gateway has already issued and surface repair in the UI.
        permissionWarning = true;
      }
    }
    await serializeProbeWork(() =>
      serializeQueueWork(async () => {
        if (config) {
          const previous = await loadConfig();
          const identityChanged =
            !previous ||
            previous.gatewayUrl !== config.gatewayUrl ||
            previous.deviceId !== config.deviceId;
          if (identityChanged) {
            // Enter an explicit unpaired state before destroying old-identity
            // data. A mid-transition storage failure can then neither drain an
            // old queue with the new credential nor leave a half-cleared old
            // pairing claiming to be healthy.
            await clearConfig();
            await clearPushQueue(chromeLocalStore);
            await clearPushObservability(chromeLocalStore);
            await clearPendingHandoffs(chrome.storage.local);
            await chrome.storage.local.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
            await chrome.storage.local.set({ [CAPTURE_HANDOFF_OVERFLOW_KEY]: "" });
          }
          await clearPushServerState(chromeLocalStore);
          await clearPushHealth(chromeLocalStore);
          if (!identityChanged) {
            const client = await buildClient();
            if (client) await client.resetBackoff();
          }
          // Final critical write: nothing after this may turn a committed
          // pairing into a failure acknowledgement.
          await saveConfig(config, profileLabel);
        } else {
          await clearConfig();
          await clearPushQueue(chromeLocalStore);
          await clearPushObservability(chromeLocalStore);
          await clearPushServerState(chromeLocalStore);
          await clearPushHealth(chromeLocalStore);
          await clearPendingHandoffs(chrome.storage.local);
          await chrome.storage.local.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
          await chrome.storage.local.set({ [CAPTURE_HANDOFF_OVERFLOW_KEY]: "" });
        }
        // The old pairing's settings copy must not govern the new gateway.
        await clearCachedPolicy(chromeLocalStore);
        try {
          await refreshBadge();
        } catch {
          // Durable pairing/queue state is authoritative; later wakes repaint.
        }
      }),
    );
    if (!config) {
      return releaseCapturePermission();
    }
    // Capture stays off until the new gateway's policy is in hand; fetch it
    // now rather than at the first dwell.
    await currentPolicy({ refresh: true });
    if (permissionWarning) {
      return { warning: "Paired, but Chrome HTTPS page access needs repair" };
    }
    return undefined;
  });
}

/** Remove optional page access and report cleanup uncertainty to Options. */
async function releaseCapturePermission(): Promise<{ warning?: string } | void> {
  try {
    await revokeCapturePermission();
  } catch {
    // Reconciliation distinguishes an already-absent grant from failure.
  }
  try {
    const stillGranted = await reconcilePermissionWork(permissionCoordinator.reconcile());
    if (stillGranted) {
      return { warning: "Chrome kept HTTPS page access after the extension was unpaired" };
    }
  } catch (error) {
    return {
      warning: `Could not verify Chrome page access: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return undefined;
}

/**
 * Edit the shared exclusions on the gateway and adopt the policy it returns.
 * Runs on the queue lane for the same reason as a pause: a capture racing the
 * edit is judged against the settings the acknowledgement promises.
 */
function mutateExclusions(
  msg: Extract<OptionsToSwMessage, { type: "add-excluded-domain" | "remove-excluded-domain" }>,
): Promise<{ purged: number }> {
  return serializeQueueWork(async () => {
    const client = policyClient(await requirePairedConfig());
    if (msg.type === "add-excluded-domain") {
      const domain = normalizeCaptureDomain(msg.input);
      if (!domain) throw new Error("Not a valid domain");
      const { policy, purged } = await client.addExcludedDomain(domain, msg.purge === true);
      await adoptPolicy(policy);
      return { purged };
    }
    await adoptPolicy(await client.removeExcludedDomain(msg.domain));
    return { purged: 0 };
  });
}

async function dismissDiagnostics(): Promise<void> {
  await serializeQueueWork(() => clearPushDataLoss(chromeLocalStore));
  await chrome.storage.local.set({ [CAPTURE_HANDOFF_OVERFLOW_KEY]: "" });
  await refreshBadge();
}

/** Terminal rejection handler for fire-and-forget Chrome event tasks. */
function runEvent(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_DRAIN_ALARM || alarm.name === RETRY_DRAIN_ALARM) {
    runEvent(
      (async () => {
        try {
          // A stale settings copy is refreshed on the drain cadence, so an
          // exclusion or pause made in another browser reaches this one.
          await currentPolicy();
          await recoverPendingHandoffs();
        } catch {
          // The normal push queue still gets a chance to drain below.
        } finally {
          await drainOnce();
        }
      })(),
    );
  } else if (alarm.name === PERMISSION_RECONCILE_ALARM) {
    runEvent(reconcilePermissionWork(permissionCoordinator.reconcile(true)));
  }
});

const permissionCoordinator = new CapturePermissionCoordinator({
  hasPermission: hasCapturePermission,
  saveState: saveCapturePermissionState,
  syncContentScript: syncCaptureContentScript,
  clearUnauthorizedHandoffs: () =>
    serializeQueueWork(async () => {
      await clearPendingHandoffs(chrome.storage.local);
      await chrome.storage.local.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
    }),
  refreshStatus: refreshBadge,
});

/** Retry transient Chrome/storage failures without treating unknown as revoked. */
async function reconcilePermissionWork<T>(work: Promise<T>): Promise<T> {
  try {
    const result = await work;
    try {
      await chrome.alarms.clear(PERMISSION_RECONCILE_ALARM);
    } catch {
      // A redundant one-shot reconciliation is harmless.
    }
    return result;
  } catch (error) {
    chrome.alarms.create(PERMISSION_RECONCILE_ALARM, { delayInMinutes: 1 });
    throw error;
  }
}

chrome.permissions.onAdded.addListener((permissions) => {
  runEvent(reconcilePermissionWork(permissionCoordinator.handleAdded(permissions)));
});
chrome.permissions.onRemoved.addListener((permissions) => {
  runEvent(reconcilePermissionWork(permissionCoordinator.handleRemoved(permissions)));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  routeBackgroundMessage(message, sender, sendResponse, {
    runtimeId: chrome.runtime.id ?? "",
    popupUrl: chrome.runtime.getURL("popup.html"),
    optionsUrl: chrome.runtime.getURL("options.html"),
    handleCapture,
    drain: drainOnce,
    judgeEligibility,
    handlePause: handlePauseMessage,
    dismissDiagnostics,
    checkNow: handleCheckNow,
    readPolicy: readPolicySnapshot,
    mutateExclusions,
    changePairing: handlePairingState,
  }),
);

// On every worker spawn: (re)register the periodic drain alarm and kick an
// immediate drain so a backlog left by a previous (evicted) generation starts
// flowing without waiting for the first periodic tick.
ensureDrainAlarm();
runEvent(reconcilePermissionWork(permissionCoordinator.reconcile()));
runEvent(
  (async () => {
    try {
      // An install still holding the combined pairing record splits it into
      // the current keys before anything reads the pairing.
      await serializePairingWork(() => migrateLegacyConfig());
      await recoverPendingHandoffs();
    } catch {
      // A storage failure in the handoff outbox must not block normal draining.
    } finally {
      await drainOnce();
    }
    try {
      await migrateLegacyCaptureSettings();
    } catch {
      // The gateway was not reachable; the local list waits for the next start.
    }
  })(),
);
runEvent(refreshBadge());

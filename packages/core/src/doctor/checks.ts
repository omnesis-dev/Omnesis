// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure evaluation logic for the Omnesis doctor. Takes the folded
 * `DoctorData` bundle and returns a `DoctorReport` — no IO, no console,
 * no process state. This is the unit-testable core: feed it a fixture,
 * assert on the resulting checks. Both callers (the `omnesis doctor` CLI
 * and the gateway's `/admin/doctor` route) run this same evaluator, so a
 * check's verdict never depends on which one gathered the data.
 *
 * Every threshold lives as a named constant at the top so a reviewer can
 * tune one knob without grepping for naked numbers (same convention as
 * `cli-shared/constants.ts`). The audience is operators, so messages and
 * hints describe operational fixes ("re-auth", "install a model", "free
 * disk"), never code-level detail.
 */

import { formatSyncRemediation } from "@omnesis/types";
import { aggregateDrivingMobilePermissionCapability } from "@omnesis/types/mobile-permission-health";
import { assertNever } from "../utils.js";
import { localDeviceUpdateCommands } from "../fleet-update.js";
import { formatFleetVersionSummary, summarizeFleetVersions } from "../client-version.js";
import {
  compareStableReleaseVersions,
  isStableReleaseVersion,
  type ReleaseCheckSnapshot,
} from "../release-check.js";
import { checkGatewayTls } from "./tls-checks.js";
import {
  MAX_DOCTOR_CHECKS,
  MAX_DOCTOR_CHECK_ID_LENGTH,
  MAX_DOCTOR_HINT_LENGTH,
  MAX_DOCTOR_MESSAGE_LENGTH,
  MAX_DOCTOR_SECTION_LENGTH,
} from "./schema.js";
import type { CapabilityRole } from "../models/capabilities.js";
import type {
  DeviceEntry,
  DoctorData,
  DoctorCheck,
  DoctorReport,
  CheckStatus,
  SecurityData,
  DoctorLocalStore,
} from "./types.js";

// ── Thresholds ──────────────────────────────────────────────────────────

/**
 * Index backlog warning floor. When more than this fraction of gateway
 * documents are not yet indexed, search results are missing recent data —
 * worth flagging, but only above a tolerance so a normal incremental sync
 * (which momentarily runs ahead of the indexer) doesn't trip it.
 */
const INDEX_BACKLOG_WARN_FRACTION = 0.2;

/**
 * Free-space floor for a daemon's data volume. Gateway model/index data and
 * collector-local source state both need enough headroom for ongoing work.
 */
const DATA_VOLUME_FREE_WARN_GB = 5;

/**
 * Event-loop p95 latency warning floor (ms). Sustained lag above this
 * means the gateway is CPU-bound and HTTP requests will feel sluggish.
 * Picked well above the few-ms steady state but below the ~1s mark where
 * requests visibly stall.
 */
const EVENT_LOOP_P95_WARN_MS = 250;

/**
 * Trailing window, in seconds, that the process-vitals thresholds are
 * measured over. Exported because it is an input to the checks rather than
 * a detail of any one collector: both callers must sample the same window
 * or the same numbers would mean different things.
 */
export const PROCESS_VITALS_WINDOW_SECONDS = 60;

/**
 * Heap pressure warning floor. When the V8 heap is this close to its
 * allocated total, GC churns and an OOM is plausible under load.
 */
const HEAP_USED_WARN_FRACTION = 0.9;

/** Maximum length of an external label embedded in a one-line doctor message. */
const DOCTOR_DISPLAY_NAME_MAX_LENGTH = 256;

/** Roles doctor checks. Optional/advanced roles are not surfaced. */
const CHECKED_ROLES: CapabilityRole[] = ["embedder", "agent"];

function doctorDisplayName(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const display = normalized || fallback;
  const characters = Array.from(display);
  return characters.length <= DOCTOR_DISPLAY_NAME_MAX_LENGTH
    ? display
    : `${characters
        .slice(0, DOCTOR_DISPLAY_NAME_MAX_LENGTH - 1)
        .join("")
        .trimEnd()}…`;
}

// ── Check accumulator ────────────────────────────────────────────────────

class Checks {
  private readonly out: DoctorCheck[] = [];
  private omittedErrors = 0;
  private omittedWarnings = 0;
  private omittedOther = 0;

  add(section: string, id: string, status: CheckStatus, message: string, hint?: string): void {
    // Reserve the final slot for a severity-preserving truncation marker. This
    // makes every evaluator output valid for the bounded wire schema without
    // letting an omitted failure turn the report green.
    if (this.out.length >= MAX_DOCTOR_CHECKS - 1) {
      if (status === "fail") this.omittedErrors += 1;
      else if (status === "warn") this.omittedWarnings += 1;
      else this.omittedOther += 1;
      return;
    }
    const boundedId = boundDoctorText(id, MAX_DOCTOR_CHECK_ID_LENGTH);
    const boundedSection = boundDoctorText(section, MAX_DOCTOR_SECTION_LENGTH);
    const boundedMessage = boundDoctorText(message, MAX_DOCTOR_MESSAGE_LENGTH);
    const boundedHint = hint ? boundDoctorText(hint, MAX_DOCTOR_HINT_LENGTH) : undefined;
    this.out.push(
      boundedHint && status !== "pass" && status !== "not-applicable"
        ? {
            id: boundedId,
            section: boundedSection,
            status,
            message: boundedMessage,
            hint: boundedHint,
          }
        : { id: boundedId, section: boundedSection, status, message: boundedMessage },
    );
  }

  pass(section: string, id: string, message: string): void {
    this.add(section, id, "pass", message);
  }
  warn(section: string, id: string, message: string, hint: string): void {
    this.add(section, id, "warn", message, hint);
  }
  fail(section: string, id: string, message: string, hint: string): void {
    this.add(section, id, "fail", message, hint);
  }
  notApplicable(section: string, id: string, message: string): void {
    this.add(section, id, "not-applicable", message);
  }

  list(): DoctorCheck[] {
    const omitted = this.omittedErrors + this.omittedWarnings + this.omittedOther;
    if (omitted > 0) {
      const status: CheckStatus =
        this.omittedErrors > 0 ? "fail" : this.omittedWarnings > 0 ? "warn" : "pass";
      this.out.push({
        id: "doctor.truncated",
        section: "Doctor",
        status,
        message: `Report limit reached; omitted ${omitted} additional check(s) (${this.omittedErrors} failed, ${this.omittedWarnings} warning, ${this.omittedOther} other)`,
        ...(status === "pass"
          ? {}
          : {
              hint: "Resolve the visible findings and run the doctor again to reveal the remainder.",
            }),
      });
    }
    return this.out;
  }
}

function boundDoctorText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  let bounded = "";
  for (const character of normalized) {
    if (bounded.length + character.length > maxLength - 1) break;
    bounded += character;
  }
  return `${bounded.trimEnd()}…`;
}

// ── Section evaluators ────────────────────────────────────────────────────

function checkGateway(d: DoctorData, ck: Checks): void {
  if (!d.health.reachable) {
    const owner = d.gatewayLock;
    if (owner?.alive) {
      ck.fail(
        "Gateway",
        "gateway.reachable",
        `Gateway is not reachable, but gateway PID ${owner.pid} (started ${owner.startedAt}) still owns the config dir`,
        "It is booting, shutting down, or wedged. Follow `omnesis service logs gateway -f`; if it never answers, `omnesis service restart gateway`.",
      );
      return;
    }
    ck.fail(
      "Gateway",
      "gateway.reachable",
      "Gateway is not reachable",
      "Check that the gateway is running, then check the configured address from the device that cannot connect. A LAN address does not work away from home; connect the phone and gateway to the same private network and pair using an address reachable there. `omnesis doctor` tests only from the machine where it runs. If the gateway exits during boot, inspect `omnesis service logs gateway`.",
    );
    return;
  }
  ck.pass("Gateway", "gateway.reachable", "Gateway is reachable");

  if (d.health.version) {
    ck.pass("Gateway", "gateway.product-version", `Gateway is running ${d.health.version}`);
  }

  const release = validReleaseCheckSnapshot(d.overall?.release);
  if (release) {
    if (release.updateAvailable) {
      ck.warn(
        "Gateway",
        "gateway.release",
        `Omnesis ${release.latestVersion} is available (gateway runs ${release.currentVersion})`,
        "Run `omnesis update` on the gateway host when you are ready.",
      );
    } else if (compareStableReleaseVersions(release.currentVersion, release.latestVersion)! > 0) {
      ck.pass(
        "Gateway",
        "gateway.release",
        `Gateway ${release.currentVersion} is newer than the latest stable release visible to this install (${release.latestVersion})`,
      );
    } else {
      ck.pass(
        "Gateway",
        "gateway.release",
        `Gateway is on the latest stable release visible to this install (${release.currentVersion})`,
      );
    }
  }

  // The config store keeps its own revision counter, bumped on every write.
  // It is unrelated to the product version above; the check is named for
  // what it reads so the two are not mistaken for one another.
  if (d.config && typeof d.config.version === "number") {
    ck.pass(
      "Gateway",
      "gateway.config-revision",
      `Gateway config loaded (revision ${d.config.version})`,
    );
  } else {
    ck.warn(
      "Gateway",
      "gateway.config-revision",
      "Could not read the gateway config revision",
      "The gateway answered /health but /config did not return a revision — check the gateway log.",
    );
  }

  checkGatewayTls(d.overall?.tls, d.devices, ck);
}

function validReleaseCheckSnapshot(value: unknown): ReleaseCheckSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ReleaseCheckSnapshot>;
  if (
    !isStableReleaseVersion(candidate.currentVersion) ||
    !isStableReleaseVersion(candidate.latestVersion) ||
    (candidate.installMethod !== "source" &&
      candidate.installMethod !== "npm-global" &&
      candidate.installMethod !== "docker") ||
    typeof candidate.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.checkedAt)) ||
    typeof candidate.updateAvailable !== "boolean"
  ) {
    return null;
  }
  const comparison = compareStableReleaseVersions(
    candidate.currentVersion,
    candidate.latestVersion,
  );
  if (comparison === null || candidate.updateAvailable !== comparison < 0) return null;
  return candidate as ReleaseCheckSnapshot;
}

/**
 * Fleet versions — how the paired devices compare to the gateway they talk
 * to.
 *
 * `behind` is informational on purpose. An iOS or Android build reaches its
 * device through a store review queue, and a harness plugin is installed on
 * a machine the operator updates on their own schedule, so lagging a release
 * or two is the normal steady state rather than a defect. Only `unsupported`
 * fails: that device is below the floor this gateway declares for its kind,
 * or was last seen on a wire protocol the gateway no longer speaks — in
 * which case it cannot complete a handshake at all.
 *
 * A device that has never reported a version is counted but never faulted:
 * clients built before the ledger existed say nothing, and the check must
 * not turn that silence into an error.
 */
function checkFleetVersions(d: DoctorData, ck: Checks): void {
  if (!d.devices) return;
  const active = d.devices.filter((device) => !device.revokedAt);
  if (active.length === 0) return;

  const summary = summarizeFleetVersions(active.map((device) => device.versionState ?? "unknown"));
  const line = `${formatFleetVersionSummary(summary)} (of ${summary.total} paired ${
    summary.total === 1 ? "device" : "devices"
  })`;

  const unsupported = active.filter((device) => device.versionState === "unsupported");
  if (unsupported.length > 0) {
    ck.fail(
      "Fleet",
      "fleet.versions",
      `${unsupported.length} ${unsupported.length === 1 ? "device is" : "devices are"} too old to work with this gateway: ${unsupported
        .map((device) => `${device.name} (${device.version ?? "no version reported"})`)
        .join(", ")}`,
      "Update those devices to a supported build — run `omnesis update` on a host you control, or install the current app release on a phone. Until then they cannot sync.",
    );
    return;
  }

  const behind = active.filter((device) => device.versionState === "behind");
  if (behind.length > 0) {
    ck.pass(
      "Fleet",
      "fleet.versions",
      `${line} — behind: ${behind.map((device) => `${device.name} (${device.version})`).join(", ")}`,
    );
    return;
  }
  ck.pass("Fleet", "fleet.versions", line);
}

/**
 * A device that was revoked while it still hosts sources is a dormant
 * machine, not a retired one: nothing syncs its sources until it pairs again
 * under the same name. The repair command mints a code bound to that device
 * row, so the operator gets the exact command rather than a hunt.
 */
function checkFleetPairing(d: DoctorData, ck: Checks): void {
  if (!d.devices) return;
  const dormant = d.devices.filter((device) => device.needsPairing);
  if (dormant.length === 0) return;
  const enabledSources = (deviceId: string) =>
    (d.sources ?? []).filter((source) => source.deviceId === deviceId && source.enabled).length;
  const named = dormant.map((device) => {
    const enabled = enabledSources(device.id);
    return enabled > 0
      ? `${device.name} (${enabled} enabled source${enabled === 1 ? "" : "s"})`
      : device.name;
  });
  ck.warn(
    "Fleet",
    "fleet.needs-pairing",
    `${dormant.length} ${dormant.length === 1 ? "device is" : "devices are"} revoked but still ${
      dormant.length === 1 ? "hosts" : "host"
    } sources: ${named.join(", ")}`,
    `Nothing syncs their sources until they pair again. Bring each one back with ${dormant
      .map((device) => `\`omnesis devices repair ${shellQuote(device.name)}\``)
      .join(
        ", ",
      )} and redeem the code on that machine; its sources resume under the same device, or move them with \`omnesis sources move\`.`,
  );
}

/** A word for a pasted shell command: single-quoted, with any quote inside escaped. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function checkAuth(d: DoctorData, ck: Checks): void {
  if (d.authError) {
    ck.fail(
      "Auth & device",
      "auth.token",
      "Token rejected by the gateway (401/403)",
      "The token is expired, revoked, or under-scoped. Re-pair the device or set a valid OMNESIS_TOKEN.",
    );
    return;
  }
  if (!d.whoami) {
    // No auth error but no identity either — the gateway answered health
    // but /whoami failed for another reason (or the gateway is down).
    ck.fail(
      "Auth & device",
      "auth.token",
      "Could not resolve token identity",
      "Ensure a token exists at ~/.config/omnesis/token or set OMNESIS_TOKEN, then re-run.",
    );
    return;
  }

  ck.pass(
    "Auth & device",
    "auth.token",
    `Token valid${d.whoami.tokenId ? ` (id ${d.whoami.tokenId})` : ""}`,
  );

  if (d.whoami.scopes.length === 0) {
    ck.warn(
      "Auth & device",
      "auth.scopes",
      "Token has no scopes",
      "A scopeless token cannot read or administer anything — issue a new token with `omnesis tokens create`.",
    );
  } else {
    ck.pass("Auth & device", "auth.scopes", `Scopes: ${d.whoami.scopes.join(", ")}`);
  }

  if (!d.whoami.deviceId) {
    ck.warn(
      "Auth & device",
      "auth.device",
      "Token is not bound to a device (portal session)",
      "Day-to-day operation should use a paired device token — pair one with `omnesis devices pair`.",
    );
    return;
  }
  ck.pass(
    "Auth & device",
    "auth.device",
    `Paired device: ${d.whoami.deviceName ?? d.whoami.deviceId}`,
  );
}

function checkModels(d: DoctorData, ck: Checks): void {
  if (!d.models) {
    ck.warn(
      "Models",
      "models.unavailable",
      "Could not read model status",
      "Needs an admin-scoped token. Run `omnesis whoami` to confirm scopes, or check the gateway log.",
    );
    return;
  }

  const assignments = d.models.inference.assignments;
  const codex = d.models.inference.codex;
  const codexAssigned = Object.values(assignments).some(
    (assignment) => assignment?.kind === "codex",
  );
  const codexUpdate = codex?.runtimeUpdate;
  if ((codex?.configured || codexAssigned) && codexUpdate) {
    const update = codexUpdate;
    if (update.state === "up-to-date") {
      ck.pass(
        "Models",
        "models.codex-runtime",
        `Codex runtime ${update.currentVersion ?? update.targetVersion ?? "unknown"} is up to date`,
      );
    } else if (update.state === "externally-managed") {
      ck.pass("Models", "models.codex-runtime", "Codex runtime is managed outside Omnesis");
    } else {
      const repair = update.state === "repair-needed";
      ck.warn(
        "Models",
        "models.codex-runtime",
        repair ? "Codex runtime needs repair" : "A tested Codex runtime update is available",
        repair
          ? "Repair the gateway-owned runtime with `omnesis codex update --yes`."
          : "Install the tested runtime with `omnesis codex update --yes`.",
      );
    }
  }
  for (const role of CHECKED_ROLES) {
    const a = assignments[role];
    const id = `models.${role}`;
    // Embedder is load-bearing for indexing + search; its absence is a
    // hard failure. Agent availability only affects an optional feature.
    const severity: "fail" | "warn" = role === "embedder" ? "fail" : "warn";
    const emit = (message: string, hint: string) =>
      severity === "fail"
        ? ck.fail("Models", id, message, hint)
        : ck.warn("Models", id, message, hint);

    if (!a || a.kind === "disabled") {
      emit(
        `${role} is not configured`,
        role === "embedder"
          ? "Search and indexing cannot run without an embedder. Install one with `omnesis models install <id>` and assign it with `omnesis models use embedder <id>`."
          : `Assign ${article(role)} ${role} model with \`omnesis models use ${role} <id>\` to enable it.`,
      );
      continue;
    }
    if (a.kind === "unresolved") {
      emit(
        `${role} assignment could not be resolved`,
        `Check the inference assignment for ${role} in omnesis.json (\`omnesis models list\`).`,
      );
      continue;
    }
    if (a.kind === "replay") {
      // Fixture playback — fine in dev/demo, surfaced as info-level pass.
      ck.pass("Models", id, `${role} uses the replay backend (fixtures)`);
      continue;
    }

    // local / http / anthropic / codex all carry `available`.
    if (!a.available) {
      const why = a.reason ? ` (${a.reason})` : "";
      if (a.kind === "local") {
        emit(
          `${role} model "${a.catalogId}" is not available${why}`,
          `The model file is missing or not loaded — install it with \`omnesis models install ${a.catalogId}\`.`,
        );
      } else if (a.kind === "http") {
        emit(
          `${role} backend "${a.backendKey}" is unavailable${why}`,
          `Confirm the HTTP backend at ${a.url} is running and reachable.`,
        );
      } else if (a.kind === "anthropic") {
        emit(
          `${role} (Anthropic) is unavailable${why}`,
          "Confirm the Anthropic API key is configured and valid.",
        );
      } else {
        emit(
          `${role} (Codex) is unavailable${why}`,
          "Confirm Codex is logged in (omnesis codex login) and the gateway can reach it.",
        );
      }
      continue;
    }

    const label =
      a.kind === "local"
        ? a.catalogId
        : a.kind === "http"
          ? `${a.backendKey}/${a.model}`
          : a.kind === "anthropic"
            ? a.apiModelId
            : `codex/${a.model}`;
    if (a.kind === "codex") {
      ck.pass(
        "Models",
        id,
        `${role} configured (${label}; Codex runtime is verified on the first agent turn)`,
      );
      continue;
    }
    ck.pass("Models", id, `${role} ready (${label})`);
  }
}

function checkSources(d: DoctorData, ck: Checks): void {
  if (!d.sources) {
    ck.warn(
      "Sources & sync",
      "sources.unavailable",
      "Could not read configured sources",
      "Needs an admin-scoped token. Run `omnesis whoami` to confirm scopes.",
    );
    return;
  }

  const enabled = d.sources.filter((s) => s.enabled);
  if (enabled.length === 0) {
    ck.warn(
      "Sources & sync",
      "sources.any",
      "No sources are enabled",
      "Nothing is being indexed. Add a source with `omnesis sources add`.",
    );
  } else {
    ck.pass("Sources & sync", "sources.any", `${enabled.length} source(s) enabled`);
  }

  const sync = d.syncStatus ?? [];
  for (const source of sync) {
    if (source.state === "paused" || !source.issues?.length) continue;
    for (const [index, issue] of source.issues.entries()) {
      ck.warn(
        "Sources & sync",
        `sources.sync-issue.${source.sourceId}.${index}`,
        `${source.sourceId}: ${issue.message} (since ${new Date(issue.since).toISOString()})`,
        issue.remediation
          ? formatSyncRemediation(issue.remediation)
          : "Review the affected data and collector diagnostics, then sync again.",
      );
    }
  }
  const byId = new Map(sync.map((s) => [s.sourceId, s]));

  const needsAuth = sync.filter((s) => s.state === "needs-auth");
  if (needsAuth.length > 0) {
    ck.warn(
      "Sources & sync",
      "sources.needs-auth",
      `${needsAuth.length} source(s) need re-authentication: ${needsAuth.map((s) => s.sourceId).join(", ")}`,
      "Refresh credentials with `omnesis sources reauth <provider-id>` (or via the portal).",
    );
  }

  // Consent that has not lapsed yet but will. Reported separately from
  // `needs-auth` because the source is still syncing fine — reconnecting
  // now avoids the outage rather than recovering from one.
  const authExpiring = sync.filter((s) => s.state === "auth-expiring");
  if (authExpiring.length > 0) {
    ck.warn(
      "Sources & sync",
      "sources.auth-expiring",
      `${authExpiring.length} source(s) have credentials expiring soon: ${authExpiring.map((s) => s.sourceId).join(", ")}`,
      "Reconnect before the deadline with `omnesis sources reauth <provider-id>` (or via the portal) to avoid an interruption.",
    );
  }

  // A source whose local data feed has stalled. Like `auth-expiring`, reported
  // separately from a failure because sync is still succeeding — what stopped is
  // the data arriving, and the fix is on the operator's machine rather than in
  // Omnesis. Each source carries its own remediation sentence, so they are
  // reported one per line instead of collapsed into a count.
  const stale = sync.filter((s) => s.state === "stale");
  for (const s of stale) {
    ck.warn(
      "Sources & sync",
      `sources.stale.${s.sourceId}`,
      `Source "${s.sourceId}" is syncing but no longer receiving new data`,
      s.staleHint ??
        "The app that maintains this source's local data isn't running on its host. Open it to resume syncing.",
    );
  }

  // Two replicas of one store disagree about whether an item exists: one
  // reported it deleted, another still holds it. The gateway keeps the item
  // until they agree — usually the second replica has simply not received the
  // deletion yet — so this is a wait, or a look at the device that is behind.
  const disputedSources = enabled.filter((s) => (s.disputedDeletions ?? 0) > 0);
  for (const s of disputedSources) {
    ck.warn(
      "Sources & sync",
      `sources.replica-dispute.${s.id}`,
      `Source "${s.id}": ${s.disputedDeletions} item(s) one device deleted are still held by another device`,
      "The items stay until every device agrees. Let the device holding them finish syncing (or sign it back in); to force the deletion, delete the item from the corpus.",
    );
  }

  const permissionDegraded = sync.filter(
    (s) =>
      s.state === "permission-degraded" ||
      s.state === "background-access-missing" ||
      s.state === "unavailable",
  );
  for (const s of permissionDegraded) {
    const issue = s.permissionHealth
      ? aggregateDrivingMobilePermissionCapability(s.permissionHealth.capabilities)
      : undefined;
    ck.warn(
      "Sources & sync",
      `sources.permission.${s.sourceId}`,
      `Source "${s.sourceId}" has degraded phone permissions${issue ? ` (${issue.label})` : ""}`,
      issue?.remediation ?? "Open Omnesis on the source phone and restore the requested access.",
    );
  }
  const permissionOverdue = sync.filter(
    (s) => s.state !== "paused" && s.permissionHealth?.reportStale === true,
  );
  for (const s of permissionOverdue) {
    ck.warn(
      "Sources & sync",
      `sources.permission-overdue.${s.sourceId}`,
      `Source "${s.sourceId}" has not reported a recent phone permission check`,
      "Open Omnesis on the source phone so it can verify background access.",
    );
  }

  const errored = sync.filter((s) => s.state === "error");
  for (const s of errored) {
    // A failure that named its remedy is reported as that remedy: the
    // operator has something to do, not something to inspect.
    if (s.remediation) {
      ck.warn(
        "Sources & sync",
        `sources.error.${s.sourceId}`,
        `Source "${s.sourceId}" cannot read its data on its collector: ${s.remediation.summary}`,
        formatSyncRemediation(s.remediation),
      );
      continue;
    }
    ck.warn(
      "Sources & sync",
      `sources.error.${s.sourceId}`,
      `Source "${s.sourceId}" is in error: ${s.errorMessage ?? "unknown error"}`,
      "Inspect with `omnesis sources debug " +
        s.sourceId +
        "` and re-sync once the cause is fixed.",
    );
  }

  // Source host assignment is structural evidence: pull work must belong to a
  // collector. A collector's WebSocket snapshot is deliberately not a health
  // verdict — its recurring HTTP sync loop can continue while the control
  // socket reconnects. Actual blocked work is covered by never-synced, stale,
  // needs-auth, and error evidence below/above.
  const enabledPullByDevice = new Map<string, (typeof enabled)[number][]>();
  for (const source of enabled) {
    if (source.pushBased) continue;
    const hosted = enabledPullByDevice.get(source.deviceId) ?? [];
    hosted.push(source);
    enabledPullByDevice.set(source.deviceId, hosted);
  }
  const deviceInventoryUnavailable = d.devices === null && enabledPullByDevice.size > 0;
  if (deviceInventoryUnavailable) {
    ck.warn(
      "Sources & sync",
      "sources.device-inventory-unavailable",
      "Could not verify source host assignments",
      "Needs an admin-scoped token. Run `omnesis whoami` to confirm scopes, or check the gateway log.",
    );
  }

  const deviceById = new Map((d.devices ?? []).map((device) => [device.id, device]));
  const invalidCollectorHosts =
    d.devices === null
      ? []
      : [...enabledPullByDevice].flatMap(([deviceId, hosted]) => {
          const device = deviceById.get(deviceId);
          return device?.kind === "collector" ? [] : [{ deviceId, device, hosted }];
        });
  for (const { deviceId, device, hosted } of invalidCollectorHosts) {
    if (device) {
      ck.warn(
        "Sources & sync",
        `sources.collector-host-invalid.${deviceId}`,
        `Device "${device.name}" (${device.kind}) cannot run ${hosted.length} enabled pull source(s): ${hosted.map((s) => s.id).join(", ")}`,
        "Reassign or recreate these sources on a collector device.",
      );
    } else {
      ck.warn(
        "Sources & sync",
        `sources.collector-host-missing.${deviceId}`,
        `${hosted.length} enabled pull source(s) reference a missing collector (${deviceId}): ${hosted.map((s) => s.id).join(", ")}`,
        "Reassign or recreate these sources on a paired collector device.",
      );
    }
  }

  const invalidCollectorIds = new Set(invalidCollectorHosts.map(({ deviceId }) => deviceId));

  // Pull sources enabled but never synced (no lastSyncedAt and no sync row
  // with a lastSyncAt) may be stuck waiting on the collector. Push-based
  // sources do not run a sync loop, so a missing sync timestamp is expected.
  // An invalid host already carries the more useful root-cause warning and
  // source list, so do not repeat those sources here.
  const neverSynced = enabled.filter((s) => {
    if (s.pushBased || invalidCollectorIds.has(s.deviceId)) return false;
    const row = byId.get(s.id);
    const synced = s.lastSyncedAt ?? row?.lastSyncAt ?? null;
    return !synced && row?.state !== "syncing";
  });
  if (neverSynced.length > 0) {
    ck.warn(
      "Sources & sync",
      "sources.never-synced",
      `${neverSynced.length} enabled source(s) have never synced: ${neverSynced.map((s) => s.id).join(", ")}`,
      "Trigger a first sync with `omnesis sources sync <pattern>` and confirm the collector is online.",
    );
  }

  if (
    needsAuth.length === 0 &&
    authExpiring.length === 0 &&
    stale.length === 0 &&
    disputedSources.length === 0 &&
    permissionDegraded.length === 0 &&
    permissionOverdue.length === 0 &&
    errored.length === 0 &&
    !deviceInventoryUnavailable &&
    invalidCollectorHosts.length === 0 &&
    neverSynced.length === 0 &&
    enabled.length > 0
  ) {
    ck.pass("Sources & sync", "sources.healthy", "All enabled sources are healthy");
  }
}

/**
 * Source state that can be proved by the collector itself. Gateway-only
 * inventory questions (ownership, replica disputes and device assignment)
 * deliberately stay out of this path: absent gateway evidence must not turn
 * into a warning about the collector host.
 */
function checkLocalSourceStatus(d: DoctorData, ck: Checks): void {
  const sync = d.syncStatus;
  if (!sync) {
    ck.warn(
      "Sources & sync",
      "sources.local-status-unavailable",
      "Could not read this collector's local source status",
      "Check the collector log and retry the device doctor.",
    );
    return;
  }

  const needsAuth = sync.filter((source) => source.state === "needs-auth");
  if (needsAuth.length > 0) {
    ck.warn(
      "Sources & sync",
      "sources.needs-auth",
      `${needsAuth.length} local source(s) need re-authentication: ${needsAuth.map((source) => source.sourceId).join(", ")}`,
      "Refresh the affected source credentials, then let the collector sync again.",
    );
  }

  const authExpiring = sync.filter((source) => source.state === "auth-expiring");
  if (authExpiring.length > 0) {
    ck.warn(
      "Sources & sync",
      "sources.auth-expiring",
      `${authExpiring.length} local source(s) have credentials expiring soon: ${authExpiring.map((source) => source.sourceId).join(", ")}`,
      "Reconnect the affected sources before their credentials expire.",
    );
  }

  const stale = sync.filter((source) => source.state === "stale");
  for (const source of stale) {
    ck.warn(
      "Sources & sync",
      `sources.stale.${source.sourceId}`,
      `Source "${source.sourceId}" is syncing but no longer receiving new data`,
      source.staleHint ??
        "The app that maintains this source's local data isn't running on this host. Open it to resume syncing.",
    );
  }

  const errored = sync.filter((source) => source.state === "error");
  for (const source of errored) {
    if (source.remediation) {
      ck.warn(
        "Sources & sync",
        `sources.error.${source.sourceId}`,
        `Source "${source.sourceId}" cannot read its local data: ${source.remediation.summary}`,
        formatSyncRemediation(source.remediation),
      );
      continue;
    }
    ck.warn(
      "Sources & sync",
      `sources.error.${source.sourceId}`,
      `Source "${source.sourceId}" is in error`,
      "Inspect the collector log and retry the source once the cause is fixed.",
    );
  }

  if (
    needsAuth.length === 0 &&
    authExpiring.length === 0 &&
    stale.length === 0 &&
    errored.length === 0
  ) {
    ck.pass(
      "Sources & sync",
      "sources.healthy",
      sync.length === 0
        ? "This collector has no local source status entries"
        : "No errors in the last reported local sync status",
    );
  }
}

function checkSourceReadAccess(d: DoctorData, ck: Checks): void {
  if (!d.sourceReadAccess) {
    ck.warn(
      "Source access",
      "sources.read-access-unavailable",
      "Fresh source read access was not checked",
      "Run health checks from a collector that supports fresh source access probes.",
    );
    return;
  }
  if (d.sourceReadAccess.length === 0) {
    ck.notApplicable(
      "Source access",
      "sources.read-access-empty",
      "No active source inputs to check",
    );
  }
  for (const entry of d.sourceReadAccess) {
    const id = `sources.read-access.${entry.sourceId}`;
    const hint = entry.remediation
      ? formatSyncRemediation(entry.remediation)
      : "Check the source's local inputs and the collector's permissions, then run health checks again.";
    switch (entry.status) {
      case "readable":
        ck.pass(
          "Source access",
          id,
          `Source "${entry.sourceId}" passed its fresh local read-access probe`,
        );
        break;
      case "denied":
        ck.warn("Source access", id, `Source "${entry.sourceId}" read access was denied`, hint);
        break;
      case "unavailable":
        ck.warn(
          "Source access",
          id,
          `Source "${entry.sourceId}" read access could not be verified`,
          hint,
        );
        break;
      case "unsupported":
        ck.notApplicable(
          "Source access",
          id,
          `Source "${entry.sourceId}" does not provide a local read-access probe`,
        );
        break;
      default:
        assertNever(entry.status);
    }
  }
}

function markGatewayOnlyChecksNotApplicable(ck: Checks): void {
  const reason = "Evaluated only on the gateway host";
  ck.notApplicable("Gateway", "gateway.not-applicable", reason);
  ck.notApplicable("Models", "models.not-applicable", reason);
  ck.notApplicable("Fleet", "fleet.not-applicable", reason);
  ck.notApplicable("Push", "push.not-applicable", reason);
  ck.notApplicable("Index", "index.not-applicable", reason);
  ck.notApplicable(
    "Sources & sync",
    "sources.gateway-inventory",
    "Cross-device ownership and replica state are evaluated only on the gateway host",
  );
  ck.notApplicable(
    "Storage",
    "storage.db",
    "Gateway database size is evaluated only on the gateway host",
  );
  ck.notApplicable("Sweeps", "sweeps.not-applicable", reason);
}

function checkCollectorStorage(d: DoctorData, ck: Checks): void {
  const free = d.systemInfo?.dataDirFreeGb;
  if (free === undefined) {
    ck.warn(
      "Storage",
      "storage.disk-unavailable",
      "Could not read free space on this collector's data volume",
      "Check the collector log and verify that its data directory is accessible.",
    );
    return;
  }
  if (free < DATA_VOLUME_FREE_WARN_GB) {
    ck.warn(
      "Storage",
      "storage.disk",
      `Low free disk on the collector data volume: ${free.toFixed(1)} GB`,
      `Free up space — local source state needs headroom (warns below ${DATA_VOLUME_FREE_WARN_GB} GB).`,
    );
    return;
  }
  ck.pass("Storage", "storage.disk", `${free.toFixed(1)} GB free on the collector data volume`);
}

/**
 * An update a device reported as failed, or one installed but not loaded
 * until something the operator owns restarts it, stays on the device's row
 * until the device reconnects on the version it was asked for; a build that
 * answered it cannot take the command stays until it reports another version.
 * Naming these here keeps a result an updater printed once from living only
 * in the scrollback of the terminal that ran it.
 */
function checkFleetUpdates(d: DoctorData, ck: Checks): void {
  if (!d.devices) return;
  const live = d.devices.filter((device) => !device.revokedAt);
  const running = (device: DeviceEntry): string => device.version ?? "an unknown version";
  // The detail is text the device wrote; it must not steer the terminal.
  const detailOf = (device: DeviceEntry): string | null =>
    device.updateDetail ? device.updateDetail.replace(/[\u0000-\u001f\u007f]/gu, "") : null;
  const failed = live.filter((device) => device.updateState === "failed");
  if (failed.length > 0) {
    ck.warn(
      "Fleet",
      "fleet.update-failed",
      `${failed.length === 1 ? "An update" : `${failed.length} updates`} did not land: ${failed
        .map(
          (device) =>
            `${device.name} still runs ${running(device)}${device.desiredVersion ? ` instead of ${device.desiredVersion}` : ""}${detailOf(device) ? ` (${detailOf(device)})` : ""}`,
        )
        .join("; ")}`,
      failed
        .map((device) =>
          device.harness
            ? `On ${device.name}'s machine run \`omnesis connect ${device.harness} --refresh\`, then \`${device.harness} gateway restart\`.`
            : `On ${device.name}'s machine run \`omnesis update\`, or ask again with \`omnesis update --fleet\`.`,
        )
        .join(" ") +
        " The notice clears once the device reconnects on that version or a newer one.",
    );
  }
  const restartPending = live.filter((device) => device.updateState === "restart-pending");
  if (restartPending.length > 0) {
    ck.warn(
      "Fleet",
      "fleet.restart-pending",
      `${restartPending.length === 1 ? "A device has" : `${restartPending.length} devices have`} an update installed but not loaded: ${restartPending
        .map(
          (device) =>
            `${device.name} runs ${running(device)}${device.desiredVersion ? ` with ${device.desiredVersion} installed` : ""}`,
        )
        .join("; ")}`,
      restartPending
        .map((device) =>
          detailOf(device)
            ? `${device.name}: ${detailOf(device)}`
            : device.harness
              ? `Run \`${device.harness} gateway restart\` on its machine so it loads the installed plugin.`
              : `Restart ${device.name} so it loads the installed build.`,
        )
        .join(" ") + " The notice clears once the device reconnects on the installed version.",
    );
  }
  const unsupported = live.filter((device) => device.updateState === "unsupported");
  if (unsupported.length > 0) {
    ck.warn(
      "Fleet",
      "fleet.update-unsupported",
      `${unsupported.length === 1 ? "A device runs a build" : `${unsupported.length} devices run builds`} that cannot be updated remotely: ${unsupported
        .map((device) => `${device.name} (${running(device)})`)
        .join("; ")}`,
      unsupported
        .map(
          (device) =>
            `On ${device.name}'s machine run ${localDeviceUpdateCommands(device.harness)
              .map((command) => `\`${command}\``)
              .join(", then ")}.`,
        )
        .join(" ") +
        " The gateway does not ask such a build to update itself; the notice clears once the device reports another version.",
    );
  }
}

/**
 * A harness whose corpus-access authorization has lapsed needs a human at a
 * browser; the gateway derives that from its credentials on every read, so
 * the check clears itself once the command has been run.
 */
function checkFleetAuthorization(d: DoctorData, ck: Checks): void {
  if (!d.devices) return;
  const lapsed = d.devices.flatMap((device) =>
    !device.revokedAt && device.agentAuthorization?.status === "needs-reauthorization"
      ? [{ name: device.name, remedy: device.agentAuthorization.remedy }]
      : [],
  );
  if (lapsed.length === 0) return;
  ck.warn(
    "Fleet",
    "fleet.agent-authorization",
    `${lapsed.length === 1 ? "An agent integration needs" : `${lapsed.length} agent integrations need`} a human to re-authorize corpus access: ${lapsed.map((device) => device.name).join(", ")}`,
    lapsed
      .map(
        (device) =>
          `On ${device.name}'s machine run \`${device.remedy}\` and approve it in the portal.`,
      )
      .join(" "),
  );
}

function checkPush(d: DoctorData, ck: Checks): void {
  if (d.devices === null) {
    ck.warn(
      "Push",
      "push.inventory",
      "Push registration health could not be inspected",
      "Run `omnesis push status` once the gateway is reachable.",
    );
    return;
  }
  // A revoked phone is not a push target; it stays out of the inventory.
  const phones = d.devices.filter(
    (device) => (device.kind === "ios" || device.kind === "android") && !device.revokedAt,
  );
  if (phones.length === 0) {
    ck.pass("Push", "push.inventory", "No paired phones require push registration");
    return;
  }
  const unavailable = phones.filter(
    (device) => !device.pushTransport || device.pushPlan?.transport === "unavailable",
  );
  if (unavailable.length > 0) {
    // Four different fixes, never conflated: the phone's consent, the app's
    // identity, the gateway's relay endpoint, or a registration to redo.
    const reasonCodeOf = (device: DeviceEntry) =>
      device.pushPlan?.transport === "unavailable" ? device.pushPlan.reasonCode : undefined;
    const groups = {
      consent: unavailable.filter((device) => reasonCodeOf(device) === "relay-disabled"),
      identity: unavailable.filter((device) => reasonCodeOf(device) === "no-direct-credential"),
      endpoint: unavailable.filter((device) => reasonCodeOf(device) === "relay-url-unavailable"),
      // A plan the gateway could serve: the phone's registration is what is missing.
      registration: unavailable.filter(
        (device) => device.pushPlan != null && device.pushPlan.transport !== "unavailable",
      ),
      // No plan at all: the phone never announced its app, so nothing can be told apart yet.
      unannounced: unavailable.filter((device) => device.pushPlan == null),
    };
    // The plan's reason is named beside a phone that has one; a phone with
    // none is listed bare, since its registration is what is missing.
    // The plan's reason can carry the app id the phone declared, so it gets
    // the same normalization a device name does.
    const named = (device: DeviceEntry): string =>
      device.pushPlan?.transport === "unavailable"
        ? `${doctorDisplayName(device.name, device.id)} (${doctorDisplayName(device.pushPlan.reason, "unavailable")})`
        : doctorDisplayName(device.name, device.id);
    const hints = [
      ...(groups.consent.length > 0
        ? ["Open the Omnesis app on each affected phone and approve relay notifications."]
        : []),
      ...(groups.identity.length > 0
        ? [
            "A self-built app needs your own APNs or FCM credentials (`omnesis push setup`), or install the official app; changing the relay URL does not authorize it.",
          ]
        : []),
      ...(groups.endpoint.length > 0
        ? ["The relay endpoint is unavailable: check `gateway.pushRelay.url`."]
        : []),
      ...(groups.registration.length > 0
        ? ["Open the app on each remaining phone to refresh its push registration."]
        : []),
      ...(groups.unannounced.length > 0
        ? [
            "Open each phone app that has not announced its app identity, so the gateway can say what it needs; run `omnesis push setup` for a self-built app that needs direct credentials.",
          ]
        : []),
    ];
    ck.warn(
      "Push",
      "push.inventory",
      `${unavailable.length}/${phones.length} paired phone(s) have no usable push transport: ${unavailable.map(named).join(", ")}`,
      hints.join(" "),
    );
    return;
  }
  const degraded = phones.filter(
    (device) =>
      device.notificationDeliveryHealth !== undefined &&
      device.notificationDeliveryHealth !== null &&
      device.notificationDeliveryHealth !== "healthy",
  );
  if (degraded.length > 0) {
    const scheduled = degraded.filter(
      (device) => device.notificationDeliveryHealth === "scheduled-summary",
    );
    const detail =
      scheduled.length > 0
        ? `${scheduled.length}/${phones.length} paired phone(s) report iOS Scheduled Summary batching`
        : `${degraded.length}/${phones.length} paired phone(s) report notifications will not alert normally`;
    ck.warn(
      "Push",
      "push.delivery-health",
      detail,
      "Open notification settings on the affected phone; turn off Scheduled Summary for Omnesis and allow alerts.",
    );
    return;
  }
  const unreported = phones.filter(
    (device) =>
      device.notificationDeliveryHealth === undefined || device.notificationDeliveryHealth === null,
  );
  if (unreported.length > 0) {
    ck.warn(
      "Push",
      "push.delivery-health",
      `${unreported.length}/${phones.length} paired phone(s) have not reported notification delivery health`,
      "Open each phone app once, then run doctor again.",
    );
    return;
  }
  const summary = new Map<string, number>();
  for (const phone of phones) {
    const transport = phone.pushTransport!;
    summary.set(transport, (summary.get(transport) ?? 0) + 1);
  }
  ck.pass(
    "Push",
    "push.inventory",
    `${phones.length} paired phone(s) registered (${[...summary].map(([name, count]) => `${count} ${name}`).join(", ")})`,
  );
}

function checkIndex(d: DoctorData, ck: Checks): void {
  const idx = d.indexStats;
  if (!idx) {
    ck.warn(
      "Index",
      "index.unavailable",
      "Could not read index stats",
      "Check the gateway log — the indexer may not be wired in.",
    );
    return;
  }

  if (!idx.enabled) {
    // Disabled because the embedder model file is missing is a real
    // problem; disabled for any other reason is at least worth a warning.
    if (idx.state === "model-missing" || idx.model?.present === false) {
      ck.fail(
        "Index",
        "index.model",
        "Index disabled — embedding model file is missing",
        "Install the embedding model with `omnesis models install <id>` so indexing and search can run.",
      );
    } else {
      ck.warn(
        "Index",
        "index.enabled",
        `Indexing is disabled${idx.state ? ` (state: ${idx.state})` : ""}`,
        "Search will only cover already-indexed documents. Enable indexing in omnesis.json.",
      );
    }
    return;
  }

  ck.pass("Index", "index.enabled", "Indexing is enabled");

  const total = idx.totalGatewayDocs ?? 0;
  const indexed = idx.totalIndexed ?? 0;
  if (total > 0) {
    const backlog = (total - indexed) / total;
    if (backlog > INDEX_BACKLOG_WARN_FRACTION) {
      ck.warn(
        "Index",
        "index.backlog",
        `Index backlog: ${(backlog * 100).toFixed(0)}% of ${total.toLocaleString()} documents not yet indexed`,
        "The indexer is behind. Give it time, or check the gateway log for indexer errors.",
      );
    } else {
      ck.pass(
        "Index",
        "index.backlog",
        `Index up to date (${indexed.toLocaleString()}/${total.toLocaleString()} documents)`,
      );
    }
  }

  // Per-source index errors.
  const erroredSources: string[] = [];
  for (const [sourceId, s] of Object.entries(idx.bySource ?? {})) {
    if ((s.indexErrors ?? 0) > 0) erroredSources.push(`${sourceId} (${s.indexErrors})`);
  }
  if (erroredSources.length > 0) {
    ck.warn(
      "Index",
      "index.errors",
      `Indexing errors on: ${erroredSources.join(", ")}`,
      "Retry failed documents with `omnesis sources reindex-missing`.",
    );
  }
}

function checkStorage(d: DoctorData, ck: Checks): void {
  if (d.systemInfo) {
    const free = d.systemInfo.modelsDirFreeGb;
    if (free < DATA_VOLUME_FREE_WARN_GB) {
      ck.warn(
        "Storage",
        "storage.disk",
        `Low free disk on the models/data volume: ${free.toFixed(1)} GB`,
        `Free up space — model installs and the index DB need headroom (warns below ${DATA_VOLUME_FREE_WARN_GB} GB).`,
      );
    } else {
      ck.pass("Storage", "storage.disk", `${free.toFixed(1)} GB free on the models/data volume`);
    }
  }

  const diskUsage = d.overall?.diskUsage;
  if (diskUsage && typeof diskUsage.totalBytes === "number") {
    const parts = diskUsage.stores
      .map((store) => `${store.label.toLowerCase()} ${formatBytes(store.bytes)}`)
      .join(", ");
    ck.pass(
      "Storage",
      "storage.db",
      `Gateway data on disk: ${formatBytes(diskUsage.totalBytes)}${parts ? ` (${parts})` : ""}`,
    );
  } else if (d.overall && typeof d.overall.dbSizeBytes === "number") {
    ck.pass("Storage", "storage.db", `Gateway DB size: ${formatBytes(d.overall.dbSizeBytes)}`);
  }
}

function checkConfig(d: DoctorData, ck: Checks): void {
  if (!d.configStatus) {
    // Not necessarily a problem — config-store admin route needs admin
    // scope and isn't mounted in every deployment.
    return;
  }
  if (d.configStatus.ok && !d.configStatus.lastError) {
    ck.pass("Config", "config.load", `Config loaded cleanly (version ${d.configStatus.version})`);
  } else {
    const msg = d.configStatus.lastError?.message ?? "unknown error";
    ck.fail(
      "Config",
      "config.load",
      `Config failed to load: ${msg}`,
      `The ${d.target} is running on the last-good config. Fix omnesis.json (\`omnesis config edit\`) — invalid edits are rejected and logged.`,
    );
  }
}

/**
 * Sweep files. A file the loader could not read is the failure mode worth
 * shouting about: nothing breaks, the sweep simply never runs, and the author
 * has no reason to suspect it. The digest-window check is a warning because
 * the schedule still works — it just costs the operator a thinner morning
 * brief, which is not obvious from either surface on its own.
 */
function checkSweeps(d: DoctorData, ck: Checks): void {
  const s = d.sweeps;
  if (!s) return;
  if (!s.laneEnabled) {
    ck.warn(
      "Sweeps",
      "sweeps.lane",
      `Sweeps are switched off — ${s.enabledCount} sweep(s) are configured but none will run`,
      "Set brain.sweepsEnabled to run them; until then the Sweeps tab describes a schedule nothing is on.",
    );
  }
  if (s.issues.length === 0) {
    ck.pass("Sweeps", "sweeps.files", `${s.enabledCount} sweep(s) enabled, all files readable`);
  } else {
    for (const issue of s.issues) {
      ck.fail(
        "Sweeps",
        `sweeps.file.${issue.id}`,
        `Sweep '${issue.id}' is not running: ${issue.message}`,
        `Fix ${issue.file} — until then this sweep is skipped on every pass.`,
      );
    }
  }
  for (const conflict of s.digestWindowConflicts) {
    ck.warn(
      "Sweeps",
      `sweeps.digestWindow.${conflict.id}`,
      `Sweep '${conflict.id}' runs at ${conflict.at}, inside the morning digest's window`,
      "The digest waits for the run queue to fall quiet before it composes, so a sweep in that window delays it until the grace deadline and thins the morning brief. Give this sweep a different `at`.",
    );
  }
}

function checkProcess(d: DoctorData, ck: Checks): void {
  const pv = d.processVitals;
  if (!pv) return;

  const el = pv.eventLoop?.current;
  if (el) {
    if (el.p95Ms > EVENT_LOOP_P95_WARN_MS) {
      ck.warn(
        "Process",
        "process.eventloop",
        `Event-loop p95 latency is high: ${Math.round(el.p95Ms)}ms`,
        d.target === "gateway"
          ? `The gateway is CPU-bound — requests will feel slow (warns above ${EVENT_LOOP_P95_WARN_MS}ms). Check for a heavy backfill or rebuild in progress.`
          : `The collector is CPU-bound — sync work will be delayed (warns above ${EVENT_LOOP_P95_WARN_MS}ms). Check for a heavy sync or backfill in progress.`,
      );
    } else {
      ck.pass("Process", "process.eventloop", `Event-loop p95 latency: ${Math.round(el.p95Ms)}ms`);
    }
  }

  const mem = pv.memory?.current;
  if (mem && mem.heapTotalBytes > 0) {
    const used = mem.heapUsedBytes / mem.heapTotalBytes;
    if (used > HEAP_USED_WARN_FRACTION) {
      ck.warn(
        "Process",
        "process.memory",
        `Heap pressure: ${(used * 100).toFixed(0)}% of ${formatBytes(mem.heapTotalBytes)} used`,
        d.target === "gateway"
          ? `The gateway is near its heap ceiling (warns above ${(HEAP_USED_WARN_FRACTION * 100).toFixed(0)}%). Restart it if memory keeps climbing.`
          : `The collector is near its heap ceiling (warns above ${(HEAP_USED_WARN_FRACTION * 100).toFixed(0)}%). Restart it if memory keeps climbing.`,
      );
    } else {
      ck.pass(
        "Process",
        "process.memory",
        `Heap: ${formatBytes(mem.heapUsedBytes)} / ${formatBytes(mem.heapTotalBytes)} used`,
      );
    }
  }
}

function checkSecurity(d: DoctorData, ck: Checks): void {
  const security = d.security;
  if (!security) {
    // An audit that was asked for and failed is reported. Staying silent
    // would leave the operator reading a clean bill of health for checks
    // that never ran; only a deliberate skip omits the section entirely.
    if (d.securityError) {
      const unchecked =
        d.target === "gateway"
          ? "Permissions, disk encryption, service hardening, keyring, and storage encryption were not checked."
          : "Permissions, disk encryption, collector service hardening, and keyring health were not checked.";
      ck.warn(
        "Security",
        "security.unavailable",
        `Could not audit this host's security posture: ${d.securityError}`,
        `${unchecked} Run \`omnesis doctor\` on this host to audit them directly.`,
      );
    }
    return;
  }

  // Every check runs for both targets; the security data itself says when
  // a concern does not apply to the host that produced it (a collector has
  // no gateway process to isolate), so there is one gate, not two.
  checkSecurityPermissions(d, security, ck);
  checkDiskEncryption(security, ck);
  checkServiceHardening(security, ck);
  checkGatewayIsolation(security, ck);
  checkKeyringAccess(security, ck);
  checkKeyring(security, ck);
  checkKeyringWiring(security, ck);
  checkRecoveryEscrow(d, security, ck);
  checkDatabaseEncryption(d, security, ck);
}

function checkRecoveryEscrow(d: DoctorData, security: SecurityData, ck: Checks): void {
  const escrow = security.recoveryEscrow;
  if (escrow.status === "exported") {
    ck.pass("Security", "security.recovery-escrow", "A root-key recovery escrow is exported");
    return;
  }
  if (escrow.status === "corrupt") {
    // Re-exporting needs a readable root key; when the keyring is also lost the
    // escrow cannot be recreated, so point at recovery-from-backup instead.
    const hint = security.keyring.valid
      ? `${escrow.detail} Re-export it with \`omnesis keyring export-recovery --force\` and store the new recovery code safely.`
      : `${escrow.detail} The install root key is also unavailable, so this escrow cannot be recreated — recover the key from a backup or an escrow copy kept elsewhere.`;
    ck.fail(
      "Security",
      "security.recovery-escrow",
      "The root-key recovery escrow is corrupt",
      hint,
    );
    return;
  }
  // status === "missing": only actionable once there is a root key to escrow —
  // a plaintext install has no key, so its absence is not a finding.
  if (!security.keyring.valid) return;
  // What the key protects differs per host: a collector holds its provider
  // stores and sealed credentials, never the gateway's databases or backups.
  const atStake =
    d.target === "collector"
      ? "this collector's encrypted provider stores and sealed credentials become unrecoverable"
      : "the encrypted live stores and every encrypted backup become unrecoverable";
  ck.warn(
    "Security",
    "security.recovery-escrow",
    "No root-key recovery escrow has been exported",
    `If the OS keyring is lost, ${atStake}. Run \`omnesis keyring export-recovery\`${hostSuffix(d)} and keep the printed recovery code somewhere safe. (An envelope exported to a custom \`--out\` location is not detected here.)`,
  );
}

/** " on <host>" when the report names its host; nothing for the reader's own machine. */
function hostSuffix(d: DoctorData): string {
  return d.host ? ` on ${d.host}` : "";
}

function checkDatabaseEncryption(d: DoctorData, security: SecurityData, ck: Checks): void {
  const db = security.databaseEncryption;
  const collector = d.target === "collector";
  const subject = collector
    ? "Collector provider-store encryption"
    : "Application-level live storage encryption";
  const restart = collector ? "restart the collector" : "restart the gateway";
  if (db.status === "not-applicable") {
    ck.notApplicable("Security", "security.database-encryption", db.detail);
    return;
  }
  if (db.status === "blocked") {
    ck.fail(
      "Security",
      "security.database-encryption",
      `${subject} is required but the root key is unavailable`,
      `${db.detail} Unlock or restore the install root key${hostSuffix(d)}; the stores stay closed until it can be read.`,
    );
    return;
  }
  // What the sources found on disk outranks the key inventory: a store the
  // host's key does not open is a loss whatever the keys say, and a store
  // still in plaintext, or one with no key to verify it, is what the key
  // inventory alone would call green or merely incomplete.
  const stores = d.localStores ?? [];
  const byState = (state: DoctorLocalStore["state"]) =>
    stores.filter((store) => store.state === state);
  const describe = (list: DoctorLocalStore[]) =>
    list.map((store) => `${store.label} (${store.sourceId})`).join(", ");
  const details = (list: DoctorLocalStore[]) =>
    list
      .map((store) => store.detail)
      .filter((detail): detail is string => Boolean(detail))
      .join(" ");
  const unverifiable = byState("unverifiable");
  if (unverifiable.length > 0) {
    ck.fail(
      "Security",
      "security.database-encryption",
      `${unverifiable.length} encrypted store${unverifiable.length === 1 ? "" : "s"} did not open with this host's key: ${describe(unverifiable)}`,
      `${details(unverifiable)} Restore the keyring material that wrote ${unverifiable.length === 1 ? "it" : "them"}${hostSuffix(d)}; do not delete the store.`.trim(),
    );
    return;
  }
  const plaintext = byState("plaintext");
  const locked = byState("locked");
  const plaintextNote =
    plaintext.length > 0
      ? ` ${plaintext.length} store${plaintext.length === 1 ? " is" : "s are"} plaintext on disk: ${describe(plaintext)}.`
      : "";
  const lockedNote =
    locked.length > 0
      ? ` ${locked.length} encrypted store${locked.length === 1 ? "" : "s"} could not be verified: ${describe(locked)}. ${details(locked)}`.trimEnd()
      : "";
  if (db.status === "on") {
    if (plaintext.length > 0) {
      ck.warn(
        "Security",
        "security.database-encryption",
        `${plaintext.length} store${plaintext.length === 1 ? " is" : "s are"} still plaintext on disk: ${describe(plaintext)}`,
        `Each migrates into an encrypted file the next time its source opens it; ${restart}${hostSuffix(d)} to migrate them now.`,
      );
      return;
    }
    if (locked.length > 0) {
      ck.warn(
        "Security",
        "security.database-encryption",
        `${locked.length} encrypted store${locked.length === 1 ? "" : "s"} could not be verified: ${describe(locked)}`,
        `${details(locked)} Check \`omnesis keyring status\`${hostSuffix(d)}; a store written under a key this host no longer holds needs that keyring material restored.`.trim(),
      );
      return;
    }
    const verified = byState("encrypted").length;
    ck.pass(
      "Security",
      "security.database-encryption",
      collector && verified > 0
        ? `${subject} is enabled (${verified} encrypted store${verified === 1 ? "" : "s"} verified)`
        : `${subject} is enabled`,
    );
    return;
  }
  if (db.status === "partial") {
    ck.warn(
      "Security",
      "security.database-encryption",
      `${subject} is partially configured`,
      `${db.detail}${plaintextNote}${lockedNote} Run \`omnesis keyring storage-init\`${hostSuffix(d)} and ${restart} to complete it.`,
    );
    return;
  }
  ck.warn(
    "Security",
    "security.database-encryption",
    `${subject} is not enabled`,
    `${db.detail}${plaintextNote}${lockedNote} Run \`omnesis keyring init\`${hostSuffix(d)} and ${restart} to enable encrypted stores.`,
  );
}

function checkSecurityPermissions(d: DoctorData, security: SecurityData, ck: Checks): void {
  const bad = security.permissionEntries.filter((entry) => !entry.ok);
  const fixed = security.permissionEntries.filter((entry) => entry.fixed);

  if (bad.length === 0) {
    const suffix =
      fixed.length > 0 ? `; repaired ${fixed.length} mode${fixed.length === 1 ? "" : "s"}` : "";
    ck.pass(
      "Security",
      "security.permissions",
      `Omnesis config tree is owner-only (${formatMode(0o700)} dirs and managed executables, ${formatMode(0o600)} other files${suffix})`,
    );
  } else {
    const shown = bad
      .slice(0, 5)
      .map((entry) => {
        const actual = entry.actualMode == null ? "missing" : formatMode(entry.actualMode);
        const expected =
          entry.expectedMode == null ? "no symlinks/special files" : formatMode(entry.expectedMode);
        return `${entry.relativePath} (${actual}, expected ${expected})`;
      })
      .join(", ");
    ck.fail(
      "Security",
      "security.permissions",
      `${bad.length} Omnesis config entr${bad.length === 1 ? "y is" : "ies are"} not owner-only: ${shown}`,
      security.fixPermissions
        ? "Some permission repairs failed. Inspect the listed paths and rerun with sufficient privileges."
        : `Run \`omnesis doctor --fix-permissions\`${hostSuffix(d)} to repair safe local modes.`,
    );
  }

  if (security.permissionScanTruncated) {
    ck.warn(
      "Security",
      "security.permissions.truncated",
      "Permission findings list was truncated after 5000 entries",
      "Rerun after fixing the listed paths; the scan still inspected the full config tree.",
    );
  }
}

function checkDiskEncryption(security: SecurityData, ck: Checks): void {
  const fde = security.diskEncryption;
  if (fde.status === "on") {
    ck.pass("Security", "security.full-disk-encryption", fde.detail);
    return;
  }
  if (fde.status === "off") {
    ck.warn(
      "Security",
      "security.full-disk-encryption",
      fde.detail,
      "Enable FileVault on macOS or LUKS/dm-crypt on Linux to protect data when the machine is powered off.",
    );
    return;
  }
  ck.warn(
    "Security",
    "security.full-disk-encryption",
    `Could not prove full-disk encryption status: ${fde.detail}`,
    "Verify FileVault/LUKS manually. Omnesis cannot currently prove this host's powered-off storage posture.",
  );
}

function checkServiceHardening(security: SecurityData, ck: Checks): void {
  if (security.serviceUnits.length === 0) return;

  const installed = security.serviceUnits.filter((unit) => unit.installed);
  if (installed.length === 0) {
    // On a hardened-only box the gateway IS a service unit — just a
    // system-level one this check does not inspect. The generic "no units,
    // run service install" message would contradict the passing
    // gateway-isolation check, so only the collector is called out.
    if (security.gatewayIsolation.status === "dedicated-user") {
      ck.warn(
        "Security",
        "security.service-hardening",
        "No user-level Omnesis service units were found (the gateway runs from the hardened system unit)",
        "If the collector runs on this host, install it with `omnesis service install collector` so it uses a hardened user unit.",
      );
      return;
    }
    if (security.serviceUnits.every((unit) => unit.component === "collector")) {
      ck.warn(
        "Security",
        "security.service-hardening",
        "No collector service unit was found",
        "Foreground runs rely on the daemon umask. Run `omnesis service install collector` to use a hardened launchd/systemd unit.",
      );
      return;
    }
    ck.warn(
      "Security",
      "security.service-hardening",
      "No Omnesis service units were found",
      "Foreground/source runs rely on the daemon umask. Run `omnesis service install` to use hardened launchd/systemd units.",
    );
    return;
  }

  const missing = installed.flatMap((unit) =>
    unit.directives
      .filter((directive) => !directive.ok)
      .map((directive) => `${unit.component}:${directive.key}`),
  );
  if (missing.length === 0) {
    ck.pass(
      "Security",
      "security.service-hardening",
      `${installed.length} service unit${installed.length === 1 ? "" : "s"} include the expected hardening directives`,
    );
  } else {
    ck.warn(
      "Security",
      "security.service-hardening",
      `Service unit hardening is incomplete: ${missing.slice(0, 8).join(", ")}`,
      "Reinstall the units with `omnesis service install` so regenerated launchd/systemd definitions include current hardening.",
    );
  }
}

/**
 * Gateway process isolation. Only the gateway is assessed — the collector
 * must run as the login user (it reads the user's own data), so it is
 * never flagged here. `not-installed` stays silent: the service-hardening
 * check already covers the no-units case.
 */
function checkGatewayIsolation(security: SecurityData, ck: Checks): void {
  const isolation = security.gatewayIsolation;
  if (isolation.status === "not-applicable") {
    ck.notApplicable("Security", "security.gateway-isolation", isolation.detail);
    return;
  }
  if (isolation.status === "not-installed") return;
  if (isolation.status === "dedicated-user") {
    ck.pass(
      "Security",
      "security.gateway-isolation",
      `Gateway runs as a dedicated user — ${isolation.detail}`,
    );
    return;
  }
  if (isolation.status === "unknown") {
    ck.warn(
      "Security",
      "security.gateway-isolation",
      `Could not determine which account the gateway runs as — ${isolation.detail}`,
      "Confirm by hand that the account is a service account with no login shell and no access to your home directory. Hosts using LDAP or SSSD keep accounts outside the local passwd file, so an unrecognised name is not necessarily wrong.",
    );
    return;
  }
  ck.warn(
    "Security",
    "security.gateway-isolation",
    "Gateway service runs as your login user",
    "File permissions do not stop other programs running under the same account from reading the corpus. `omnesis service install gateway --hardened` (Linux) or running the gateway in Docker isolates it under a dedicated user; a single-user machine may accept the current setup. The collector correctly stays as the login user.",
  );
}

function checkKeyring(security: SecurityData, ck: Checks): void {
  const keyring = security.keyring;
  const label = formatSecretBackend(keyring.store.backend);
  if (!keyring.store.available) {
    const hint =
      /persistent login collection/i.test(keyring.store.detail) ||
      keyring.store.backend === "passphrase"
        ? keyring.store.detail
        : `${keyring.store.detail} On Linux, install libsecret's \`secret-tool\` and make sure a Secret Service is running; then run \`omnesis keyring init\`. On a headless host, use the passphrase backend instead (OMNESIS_SECRET_STORE=passphrase with a boot-time passphrase).`;
    ck.warn("Security", "security.keyring", `OS keyring is not available (${label})`, hint);
    return;
  }

  if (!keyring.store.secure) {
    ck.warn(
      "Security",
      "security.keyring",
      `Omnesis root key uses ${label}, not an OS keyring`,
      `${keyring.store.detail} Use an OS-backed keyring before enabling database or credential encryption.`,
    );
    return;
  }

  if (!keyring.present) {
    ck.warn(
      "Security",
      "security.keyring",
      `OS keyring is available (${label}) but Omnesis has no install root key`,
      "Run `omnesis keyring init` on this host. Future encrypted stores will use that root key to wrap data keys.",
    );
    return;
  }

  if (!keyring.valid) {
    ck.warn(
      "Security",
      "security.keyring",
      `Omnesis install root key in ${label} has an unknown format`,
      "Do not overwrite a key after encrypted stores exist. Inspect the keyring entry and rotate deliberately.",
    );
    return;
  }

  ck.pass("Security", "security.keyring", `OS keyring root key is initialized (${label})`);
}

/**
 * Whether this process can read the install's key material at all.
 *
 * Emitted before every other keyring finding because it invalidates them: those
 * readings report "not there" for material they are not allowed to look at, so
 * an unreadable keyring makes an armed install describe itself as unarmed.
 */
function checkKeyringAccess(security: SecurityData, ck: Checks): void {
  const access = security.keyringAccess;
  if (access.readable) return;
  ck.fail(
    "Security",
    "security.keyring-readable",
    "Omnesis key material cannot be read by this process",
    `${access.detail} Until this is fixed, every other keyring finding in this report understates what is armed — an install whose keys are merely out of reach reads here as one that never had any.`,
  );
}

/**
 * Whether each installed unit can reach the keyring it names.
 *
 * The backend and its passphrase source are written into a unit at install
 * time and read at boot, and nothing between the two notices a unit that names
 * one without the other. Such a daemon starts clean and then fails on the
 * first encrypted store it opens, with an error about that store rather than
 * about the wiring — so the mismatch is worth naming here, where an operator
 * is already looking for it.
 */
function checkKeyringWiring(security: SecurityData, ck: Checks): void {
  const unwired = security.keyringWiring.filter(
    (unit) => unit.backend === "passphrase" && unit.passphraseSource === null,
  );
  if (unwired.length === 0) return;

  for (const unit of unwired) {
    // The hardened unit runs as a dynamic user, which can only reach a
    // passphrase through a systemd credential — so its repair is a different
    // command from the user unit's, and offering the file form there would
    // name the one wiring `service install --hardened` refuses.
    const reinstall =
      unit.scope === "system"
        ? `\`omnesis service install gateway --hardened --secret-store passphrase --keyring-passphrase-credential <abs-path>\``
        : `\`omnesis service install ${unit.component} --secret-store passphrase --keyring-passphrase-credential <abs-path>\` (Linux/systemd) or \`--keyring-passphrase-file <abs-path>\``;
    ck.warn(
      "Security",
      `security.keyring-wiring.${unit.scope}.${unit.component}`,
      `The ${unit.component} unit at ${unit.path} selects the passphrase keyring but names no passphrase`,
      `It sets OMNESIS_SECRET_STORE=passphrase without a source to read the passphrase from, so the daemon cannot unseal the install root key and every encrypted store stays unreadable. Reinstall the unit with a source: ${reinstall}.`,
    );
  }
}

// ── Top-level evaluator ────────────────────────────────────────────────────

/**
 * Run every section over the bundle and fold into a report. Pure — given
 * the same `DoctorData` it always yields the same `DoctorReport`. `ok` is
 * false iff at least one FAIL is present; warnings never flip `ok`.
 */
export function evaluateDoctor(d: DoctorData): DoctorReport {
  const ck = new Checks();
  if (d.target === "collector") {
    if (d.operationalChecks) {
      markGatewayOnlyChecksNotApplicable(ck);
      checkAuth(d, ck);
      checkLocalSourceStatus(d, ck);
      checkSourceReadAccess(d, ck);
      checkCollectorStorage(d, ck);
      checkConfig(d, ck);
      checkProcess(d, ck);
    }
  } else if (d.operationalChecks) {
    checkGateway(d, ck);
    // Everything past the gateway needs it reachable to mean anything.
    if (d.health.reachable) {
      checkAuth(d, ck);
      checkModels(d, ck);
      checkSources(d, ck);
      checkFleetVersions(d, ck);
      checkFleetPairing(d, ck);
      checkFleetUpdates(d, ck);
      checkFleetAuthorization(d, ck);
      checkPush(d, ck);
      checkIndex(d, ck);
      checkStorage(d, ck);
      checkConfig(d, ck);
      checkSweeps(d, ck);
      checkProcess(d, ck);
    }
  }
  checkSecurity(d, ck);

  const checks = ck.list();
  let errors = 0;
  let warnings = 0;
  for (const c of checks) {
    if (c.status === "fail") errors += 1;
    else if (c.status === "warn") warnings += 1;
  }
  return { ok: errors === 0, summary: { errors, warnings }, checks };
}

/** Indefinite article for a role noun ("an embedder", "a transcriber"). */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** Compact byte formatter (kept local — doctor's only sizing need). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

function formatSecretBackend(backend: string): string {
  switch (backend) {
    case "macos-keychain":
      return "macOS Keychain";
    case "secret-service":
      return "Linux Secret Service";
    case "passphrase":
      return "passphrase-sealed keyring";
    case "file":
      return "owner-only file fallback";
    case "unavailable":
      return "unavailable";
    default:
      return backend;
  }
}

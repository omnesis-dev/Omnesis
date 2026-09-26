// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeEmail, normalizePhone } from "@omnesis/core";
import { pushPlanRequestSchema, pushRegistrationSchema } from "@omnesis/core/push";
import {
  buildPage,
  defaultScopesForDeviceKind,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  scopesAllowedForDeviceKind,
  tryDeviceId,
  type DeviceCapability,
  type DeviceId,
} from "@omnesis/types";
import { deviceNeedsPairing } from "../../services/StatusCache.js";
import { scope } from "../../scope.js";
import { validateJson, validateQuery } from "../../validate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../errors.js";
import {
  deviceUpdateResultBody,
  createDeviceBody,
  deleteDeviceQuery,
  createPairingBody,
  fleetCommitPlanBody,
  fleetUpdateRequestBody,
  pairAddressesBody,
  pairQrBody,
  patchDeviceBody,
  revokePairingBody,
  setApnsTokenBody,
} from "../../schemas/index.js";
import { PairingQrService } from "../../services/PairingQrService.js";
import { PairingService } from "../../services/PairingService.js";
import { isStaleDeviceRevocationImpactError } from "../../../access/agent-device-authorization.js";
import { deviceVersionState } from "../../../device-version.js";
import { FleetUpdateService } from "../../services/FleetUpdateService.js";
import { log, type AdminRoutesDeps } from "./internals.js";
import type { RouteApp, AuthContext } from "../types.js";

/**
 * Validate + normalise a `selfEmails` / `selfPhones` patch (self
 * annotation). Returns the writer-bound patch; throws BadRequestError
 * with a human-readable message on the first invalid entry. Extracted
 * out of the route body so the handler stays a thin
 * 3-5 line adapter.
 */
function buildSelfInfoPatch(body: { selfEmails?: string[]; selfPhones?: string[] }): {
  selfEmails?: string[];
  selfPhones?: string[];
} {
  const patch: { selfEmails?: string[]; selfPhones?: string[] } = {};

  if (body.selfEmails !== undefined) {
    const out: string[] = [];
    for (const v of body.selfEmails) {
      const trimmed = v.trim();
      if (!trimmed) continue;
      // Basic shape check: a single `@` with non-empty local + domain.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new BadRequestError(`invalid email: ${v}`);
      }
      out.push(normalizeEmail(trimmed));
    }
    patch.selfEmails = Array.from(new Set(out));
  }

  if (body.selfPhones !== undefined) {
    const out: string[] = [];
    for (const v of body.selfPhones) {
      const trimmed = v.trim();
      if (!trimmed) continue;
      const e164 = normalizePhone(trimmed);
      if (!e164) {
        throw new BadRequestError(`invalid phone (must be E.164-parseable): ${v}`);
      }
      out.push(e164);
    }
    patch.selfPhones = Array.from(new Set(out));
  }

  return patch;
}

/** A device id from a request body, refused rather than silently dropped. */
function parseDeviceId(raw: string): DeviceId {
  const id = tryDeviceId(raw);
  if (!id) throw new BadRequestError(`invalid device id: ${raw}`);
  return id;
}

/** Relay authorization may only be granted by the paired phone it affects. */
function requireSelfBearer(auth: AuthContext, id: DeviceId): void {
  if (auth.authMethod !== "bearer" || auth.deviceId !== id) {
    throw new ForbiddenError("Forbidden: a paired phone may authorize only itself");
  }
}

/**
 * Block 1.9 — devices CRUD, network identities, /admin/devices/pair.
 *
 *   GET    /admin/devices
 *   POST   /admin/devices
 *   DELETE /admin/devices/:id
 *   PATCH  /admin/devices/:id          (self annotation)
 *   POST   /admin/devices/pair
 *   POST   /admin/devices/pair-addresses
 *   POST   /admin/devices/pair-qr
 *   GET    /admin/fleet/update
 *   POST   /admin/fleet/update
 *   POST   /devices/update-result       (a device's own host reporting on it)
 *   GET    /admin/network-identities
 */
/** The refusal for a grant wider than an integration may hold. */
const INTEGRATION_SCOPES =
  "an integration can hold only the answer scope (and write scopes); what it may read is decided by its access level";

export function mountDeviceRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const {
    writeGate: w,
    accessService,
    statusCache,
    wsServer,
    pairingTtlMs,
    tlsFingerprintSha256,
    systemTrustPairingOrigins,
    deviceService,
    pushRegistrationService,
    sourceService,
  } = deps;
  const pairingQrService = new PairingQrService({
    tlsFingerprint: tlsFingerprintSha256,
    systemTrustOrigins: systemTrustPairingOrigins,
    publiclyTrustedHosts: deps.publiclyTrustedPairingHosts,
    pairingKind: (code) => deps.pairingService.pendingPairingKind(code),
    discoverIdentities: async () => (await import("@omnesis/core")).discoverNetworkIdentities(),
    listenPort: deps.gatewayPort,
    advertisedLocalName: deps.advertisedPairingHost,
    certificateRenewsAt: deps.certificateRenewsAt,
  });
  // Production shares the instance whose WS lifecycle records reconnects;
  // narrow route tests may omit it and receive the equivalent stateless view.
  const fleetUpdate =
    deps.fleetUpdateService ??
    new FleetUpdateService({
      db: deps.db,
      writeGate: w,
      wsServer: () => wsServer,
    });
  /**
   * Devices holding a live socket right now. Adoption decisions are made
   * inside the writer transaction, which cannot see socket state, so the
   * snapshot travels with the request.
   */
  const connectedDeviceIds = (): DeviceId[] =>
    wsServer
      ? statusCache.listDevices.filter((d) => wsServer.isConnected(d.id)).map((d) => d.id)
      : [];

  app.get("/admin/devices", scope.admin(), (c) => {
    // `versionState` is computed here rather than by each consumer so the
    // portal, the CLI and the doctor all read one verdict. `updateDisposition`
    // rides along for the same reason, and so that the Devices page — which
    // polls this route — can decide which rows offer an update without a
    // second, uncached request per poll.
    //
    // A managed harness's corpus access is a third, independent fact: it can
    // lapse while the pairing stays perfectly healthy and the build is current,
    // so nothing else on this row would say so — see
    // `access/agent-device-authorization.ts`. Derived per request rather than
    // cached, because it turns on token expiry.
    const agentAuthorizations = accessService.agentDeviceAuthorizations();
    const revocationImpacts = accessService.agentDeviceRevocationImpacts();
    const devices = statusCache.listDevices.map((d) => {
      const authorization = agentAuthorizations.get(d.id);
      const revocationImpact = revocationImpacts.get(d.id);
      const pushPlan =
        (d.kind === "ios" || d.kind === "android") && d.capabilities.pushAppId
          ? pushRegistrationService.planForDevice(d, {
              platform: d.kind,
              appId: d.capabilities.pushAppId,
            })
          : null;
      return {
        ...d,
        online: wsServer?.isConnected(d.id) ?? false,
        versionState: deviceVersionState(d),
        updateDisposition: fleetUpdate.dispositionFor(d),
        needsPairing: deviceNeedsPairing(d, statusCache.sourceHostingDeviceIds.has(d.id)),
        pushPlan,
        ...(authorization ? { agentAuthorization: authorization } : {}),
        ...(d.kind === "agent"
          ? {
              revocationImpact: revocationImpact ?? {
                fingerprint: "",
                corpusCredentials: [],
                corpusAccess: [],
              },
            }
          : {}),
      };
    });
    return c.json(buildPage(devices, { hasMore: false, limit: devices.length }));
  });

  app.post("/admin/devices", scope.admin(), validateJson(createDeviceBody), async (c) => {
    const { name, kind, scopes, capabilities } = c.req.valid("json");
    if (!scopesAllowedForDeviceKind(kind, scopes)) throw new BadRequestError(INTEGRATION_SCOPES);
    let result;
    try {
      result = await w.createOrAdoptDevice({
        name,
        kind,
        scopes,
        capabilities: (capabilities ?? {}) as DeviceCapability,
        onlineDeviceIds: connectedDeviceIds(),
      });
    } catch (err) {
      throw new BadRequestError((err as Error).message);
    }
    if (result.outcome === "name-taken") {
      return c.json(
        {
          code: "DEVICE_NAME_TAKEN",
          error:
            result.kind === kind
              ? `a device named "${name}" already exists`
              : `the name "${name}" belongs to a ${result.kind} device — pick a different name, or forget that device first`,
        },
        409,
      );
    }
    if (result.outcome === "online") {
      return c.json(
        {
          code: "DEVICE_ONLINE",
          error: `the revoked device named "${name}" still holds a connection — disconnect it before registering again`,
        },
        409,
      );
    }
    const adopted = result.outcome === "adopted";
    // Any socket still authenticated with a credential this adoption deleted
    // is evicted before the new one leaves the gateway.
    if (adopted) wsServer?.disconnectDevice(result.device.id);
    // Audit trail for direct device registration (typically the local
    // collector's self-pair, or an operator via the portal). Pairing-flow
    // device creation is logged at the consumePairing site (admin/pairing.ts).
    log.info(
      `Device ${adopted ? "reclaimed" : "created"}: ${name} (${kind}) id=${result.device.id} scopes=[${scopes.join(",")}] tokenId=${result.tokenId}`,
    );
    statusCache.bump();
    return c.json({
      device: result.device,
      tokenId: result.tokenId,
      token: result.token,
      scopes,
      ...(adopted ? { reclaimed: true } : {}),
    });
  });

  app.delete("/admin/devices/pair", scope.admin(), validateJson(revokePairingBody), async (c) =>
    c.json({ revoked: await w.revokePairing(c.req.valid("json").pairingCode) }),
  );

  app.delete("/admin/devices/:id", scope.admin(), validateQuery(deleteDeviceQuery), async (c) => {
    const id = tryDeviceId(c.req.param("id"));
    if (!id) return c.json({ error: "device not found" }, 404);
    const existing = deviceService.getById(id);
    if (!existing) throw new NotFoundError("device not found");
    // Unpairing REVOKES by default: tokens and push registrations are
    // invalidated, but the device row, its sources and their data stay —
    // the id is a durable identity that cursors and stream keys hang off,
    // and pairing the same device again adopts it. `?forget=true` is
    // the explicit destructive act; the writer refuses it while sources
    // still point at the device, so removing a device can never silently
    // take a corpus with it.
    if (c.req.valid("query").forget === "true") {
      const result = await w.deleteDevice(id);
      if (!result.deleted) {
        if (result.reason === "not-found") throw new NotFoundError("device not found");
        return c.json(
          {
            code: "DEVICE_STILL_HOSTS_SOURCES",
            error: `device "${existing.name}" still hosts ${result.sourceIds.length} source(s): ${result.sourceIds.join(", ")}. Move them (omnesis sources move) or remove them first.`,
            sources: result.sourceIds,
          },
          409,
        );
      }
      wsServer?.disconnectDevice(id);
      await sourceService.releaseDeviceLeases(id);
      log.info(`Device forgotten: ${existing.name} (${existing.kind}) id=${id}`);
      statusCache.bump();
      return c.json({ ok: true, forgotten: true });
    }
    const query = c.req.valid("query");
    const pairingFence = deps.pairingService.pairingGenerationFence(
      c.req.header("omnesis-pairing-generation"),
      c.get("auth"),
    );
    let ok: boolean;
    try {
      ok = await w.revokeDevice(id, pairingFence, query.impactFingerprint);
    } catch (error) {
      if (isStaleDeviceRevocationImpactError(error)) {
        return c.json(
          {
            code: "DEVICE_REVOCATION_IMPACT_CHANGED",
            error:
              "The device's bound corpus credentials changed. Review the device and try again.",
          },
          409,
        );
      }
      return PairingService.translateStaleGeneration(error);
    }
    if (!ok) throw new NotFoundError("device not found");
    // Device tokens and bound principal credentials are gone, but a socket
    // authenticated with a device token is only re-checked at hello — evict it
    // so the device stops syncing now and a same-name re-pair isn't refused as
    // "currently online".
    wsServer?.disconnectDevice(id);
    await sourceService.releaseDeviceLeases(id);
    log.info(`Device revoked: ${existing.name} (${existing.kind}) id=${id}`);
    statusCache.bump();
    return c.json({ ok: true, revoked: true });
  });

  // Device-level self annotation. Operator pins the human-side
  // identifiers (emails / phones) for the device's owner so sources
  // emitting `isSelf: true` mentions resolve cleanly even before any
  // contacts source has synced. Boot-time `bootstrapSelfFromDevices`
  // turns this into a real `is_self` person row.
  app.patch("/admin/devices/:id", scope.admin(), validateJson(patchDeviceBody), async (c) => {
    const id = tryDeviceId(c.req.param("id"));
    if (!id) return c.json({ error: "device not found" }, 404);
    const body = c.req.valid("json");
    const existing = deviceService.getById(id);
    if (!existing) throw new NotFoundError("device not found");

    // Display rename. Identity is the device id (adopted at pair time by
    // install identity), so the name is free to change; it only has to
    // stay unique.
    if (body.name !== undefined && body.name !== existing.name) {
      const renamed = await w.renameDevice(id, body.name);
      if (!renamed.ok) {
        if (renamed.reason === "not-found") throw new NotFoundError("device not found");
        return c.json(
          { code: "DEVICE_NAME_TAKEN", error: `a device named "${body.name}" already exists` },
          409,
        );
      }
      log.info(`Device renamed: "${existing.name}" → "${body.name}" id=${id}`);
    }
    if (body.selfEmails !== undefined || body.selfPhones !== undefined) {
      await w.updateDeviceSelfInfo(id, buildSelfInfoPatch(body));
    }
    statusCache.bump();
    const updated = deviceService.getById(id);
    return c.json({ device: updated });
  });

  /**
   * The fleet update, previewed. Every device, what it is running, and
   * whether this gateway would command it — the version diff an operator
   * confirms before anything runs, on the portal and in the CLI alike.
   */
  app.get("/admin/fleet/update", scope.admin(), (c) => {
    return c.json(fleetUpdate.plan());
  });

  /** Exact source-commit preview used only by the CLI's advanced update path. */
  app.post("/admin/fleet/update/plan", scope.admin(), validateJson(fleetCommitPlanBody), (c) =>
    c.json(fleetUpdate.planCommit(c.req.valid("json").commit)),
  );

  /**
   * A device's own host reporting an update the gateway did not command: the
   * local `omnesis update` refreshing an agent harness's plugin, whose
   * outcome would otherwise exist only in that terminal's scrollback. The
   * token is the device's own, so the row it writes is its own; the state
   * then shows wherever a commanded update's does, and clears the same way.
   */
  app.post(
    "/devices/update-result",
    scope.deviceSelf(),
    validateJson(deviceUpdateResultBody),
    async (c) => {
      const recorded = await fleetUpdate.recordLocalResult(
        c.get("auth").deviceId!,
        c.req.valid("json"),
      );
      return c.json({ recorded });
    },
  );

  /** The version every commanded device is told to reach. */
  app.get("/admin/fleet/target", scope.admin(), (c) => {
    return c.json({ targetVersion: fleetUpdate.targetVersion });
  });

  /**
   * Tell devices to update themselves to this gateway's release, or to the
   * exact source commit selected by the CLI. Nothing is downloaded here and no
   * code crosses the socket: each device validates and installs the target
   * from its own configured remote.
   *
   * Always operator-initiated. Nothing in the gateway ever calls this on a
   * timer, and a device never asks to be updated.
   */
  app.post(
    "/admin/fleet/update",
    scope.admin(),
    validateJson(fleetUpdateRequestBody),
    async (c) => {
      const body = c.req.valid("json");
      const target = body.commit
        ? { kind: "commit" as const, commit: body.commit }
        : { kind: "release" as const, version: fleetUpdate.targetVersion };
      const outcomes = await fleetUpdate.request(body.deviceIds?.map(parseDeviceId), target, {
        allowRewind: body.allowRewind === true,
      });
      return c.json({
        targetVersion: fleetUpdate.targetVersion,
        ...(body.commit ? { targetCommit: body.commit } : {}),
        devices: outcomes,
      });
    },
  );

  // Deprecated request-shape compatibility for older iOS builds. This alias
  // deliberately installs the current direct transport, whose carrier
  // payload is the fixed content-free wake. There is no rich-payload fallback.
  app.post(
    "/admin/devices/:id/apns-token",
    scope.admin(),
    validateJson(setApnsTokenBody),
    async (c) => {
      const id = tryDeviceId(c.req.param("id"));
      if (!id) return c.json({ error: "device not found" }, 404);
      const existing = deviceService.getById(id);
      if (!existing) throw new NotFoundError("device not found");
      if (existing.kind !== "ios") {
        throw new BadRequestError(
          `device ${existing.name} has kind '${existing.kind}'; APNs registration is iOS-only`,
        );
      }
      const { deviceToken, environment, bundleId } = c.req.valid("json");
      await w.setDeviceApnsToken(id, {
        deviceToken,
        environment,
        bundleId,
        updatedAt: Date.now(),
      });
      log.info(`APNs registration set for device ${existing.name} (${id})`);
      statusCache.bump();
      return c.json({ ok: true });
    },
  );

  app.get(
    "/admin/devices/:id/push-plan",
    scope.admin(),
    validateQuery(pushPlanRequestSchema),
    async (c) => {
      const id = tryDeviceId(c.req.param("id"));
      if (!id) throw new NotFoundError("device not found");
      const request = c.req.valid("query");
      return c.json(pushRegistrationService.plan(id, request));
    },
  );

  app.post(
    "/admin/devices/:id/push-relay-consent",
    scope.admin(),
    validateJson(pushPlanRequestSchema),
    async (c) => {
      const id = tryDeviceId(c.req.param("id"));
      if (!id) throw new NotFoundError("device not found");
      requireSelfBearer(c.get("auth"), id);
      await pushRegistrationService.grantRelayConsent(id, c.req.valid("json"));
      log.info(`Relay push consent granted for device ${id}`);
      return c.json({ ok: true });
    },
  );

  app.delete("/admin/devices/:id/push-relay-consent", scope.admin(), async (c) => {
    const id = tryDeviceId(c.req.param("id"));
    if (!id) throw new NotFoundError("device not found");
    await pushRegistrationService.withdrawRelayConsent(id);
    return c.json({ ok: true });
  });

  app.post(
    "/admin/devices/:id/push-registration",
    scope.admin(),
    validateJson(pushRegistrationSchema),
    async (c) => {
      const id = tryDeviceId(c.req.param("id"));
      if (!id) throw new NotFoundError("device not found");
      const registration = c.req.valid("json");
      await pushRegistrationService.register(id, registration);
      return c.json({ ok: true });
    },
  );

  // Encode a versioned pairing QR payload server-side, so the payload
  // version, trust policy and field shape live in one place rather than in
  // every client. The client names the `gatewayUrl` the phone will reach; an
  // address the phone behind the code cannot use is refused with the reason.
  // Returns a JSON-encoded string ready for QR rendering.
  app.post("/admin/devices/pair-qr", scope.admin(), validateJson(pairQrBody), (c) => {
    const input = c.req.valid("json");
    const qrPayload = pairingQrService.encode(input);
    return c.json({ qrPayload });
  });

  // Every address the phone behind a pending code can be given, judged for
  // that phone: the portal and CLI offer the usable ones, best first, and say
  // where each works. The caller's own host is a candidate too, at the port
  // it reached the gateway on.
  app.post(
    "/admin/devices/pair-addresses",
    scope.admin(),
    validateJson(pairAddressesBody),
    async (c) => {
      const requestUrl = new URL(c.req.url);
      const plan = await pairingQrService.pairingAddresses({
        pairingCode: c.req.valid("json").pairingCode,
        requestHost: requestUrl.hostname,
        requestPort: requestUrl.port,
      });
      return c.json(plan);
    },
  );

  app.post("/admin/devices/pair", scope.admin(), validateJson(createPairingBody), async (c) => {
    const {
      name,
      repairDeviceId,
      kind,
      scopes: requestedScopes,
      ttlMs,
      selfEmails,
      selfPhones,
      accessLevelId,
    } = c.req.valid("json");
    // Omitted, the pairing carries the kind's canonical grant; a caller that
    // wants a different one states it.
    const scopes = requestedScopes ?? defaultScopesForDeviceKind(kind);
    if (kind === "agent" && (scopes.length !== 1 || scopes[0] !== SCOPE_SUBSCRIPTIONS_RECEIVE)) {
      throw new BadRequestError(
        `agent pairing requires exactly the ${SCOPE_SUBSCRIPTIONS_RECEIVE} scope`,
      );
    }
    if (!scopesAllowedForDeviceKind(kind, scopes)) throw new BadRequestError(INTEGRATION_SCOPES);
    // An integration is named for what it is, not after the host it runs on:
    // several can share a host, beside that host's own CLI.
    if (kind === "integration" && !repairDeviceId && !name?.trim()) {
      throw new BadRequestError("name the integration when pairing it");
    }
    // Which access level an integration answers under is an access decision,
    // made from a portal session like every other one; a code minted with a
    // token carries none, and the integration's questions are refused until the
    // operator chooses.
    if (accessLevelId !== undefined) {
      if (kind !== "integration") {
        throw new BadRequestError("only an integration is put on an access level");
      }
      if (c.get("auth").authMethod !== "portal-session") {
        throw new ForbiddenError("an integration's access level is chosen from a portal session");
      }
      if (!accessService.levelCanAnswer(accessLevelId)) {
        throw new BadRequestError("that access level cannot answer questions");
      }
    }
    // A repair pairing names the exact row it will land on. Redemption pins
    // the adoption to it, so identity — the device id every source, membership
    // and cursor hangs off — survives the credential rotation. The target need
    // not be revoked: redeeming the code rotates whatever credentials the
    // device holds, which is how an operator replaces a lost or leaked one.
    // Redemption still refuses a target holding a live socket unless the
    // redeeming host proves, with a credential of that device, that it is the
    // installation behind the socket; any other host has to wait for the
    // device to stop or be revoked.
    //
    // Portal sessions are excluded: a portal login consumes its code through
    // its own path, which resolves the row by install identity and never
    // reads the repair target, so a bound code would be silently ignored.
    const repairTargetId = repairDeviceId ? tryDeviceId(repairDeviceId) : null;
    if (repairDeviceId && !repairTargetId) throw new BadRequestError("invalid repair device id");
    if (repairTargetId) {
      if (kind === "portal") {
        throw new BadRequestError("portal sessions cannot be repaired; mint a fresh pairing code");
      }
      const repairTarget = deviceService.getById(repairTargetId);
      if (!repairTarget) throw new NotFoundError("repair device not found");
      if (repairTarget.kind !== kind) {
        throw new BadRequestError(
          `repair target is a ${repairTarget.kind} device, not a ${kind} device`,
        );
      }
      if (name?.trim() && name.trim() !== repairTarget.name) {
        throw new BadRequestError("repair pairing name must match the selected device");
      }
    }

    // Optional inline self annotation. Reuses the exact validation /
    // normalization the PATCH /admin/devices/:id (set-self) path uses, so a
    // staged-at-pairing annotation and a post-pair one land identically:
    // emails normalizeEmail-d, phones normalizePhone-d to E.164, an
    // unparseable phone rejected with 400 before the code is minted.
    const selfInfo = buildSelfInfoPatch({ selfEmails, selfPhones });

    // Body-supplied ttlMs wins. When omitted, fall back to the
    // configured default (gateway.timings.pairingTtl) so an operator
    // can lengthen pairing windows without code changes.
    const effectiveTtl = ttlMs ?? pairingTtlMs;
    // Pass the gateway's TLS leaf-cert fingerprint so the PendingPairing
    // carries it back to the CLI, which folds it into the V3 QR payload.
    // iOS pins the fingerprint on first connect (TOFU). Absent on tests
    // that skip TLS wiring; the CLI falls back to V2 in that case.
    const pending = await w.createPairing({
      name,
      kind,
      scopes,
      ttlMs: effectiveTtl,
      selfEmails: selfInfo.selfEmails,
      selfPhones: selfInfo.selfPhones,
      ...(repairTargetId ? { repairDeviceId: repairTargetId } : {}),
      ...(accessLevelId !== undefined ? { accessLevelId } : {}),
      tlsFingerprintSha256:
        typeof tlsFingerprintSha256 === "function" ? tlsFingerprintSha256() : tlsFingerprintSha256,
    });
    log.info(`Pairing code issued: ${name || "(unnamed)"} (${kind}) scopes=[${scopes.join(",")}]`);
    return c.json(pending);
  });

  app.get("/admin/network-identities", scope.admin(), async (c) => {
    const identities = await pairingQrService.networkIdentities();
    return c.json(buildPage(identities, { hasMore: false, limit: identities.length }));
  });
}

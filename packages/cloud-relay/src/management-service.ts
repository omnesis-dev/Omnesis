// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";
import { z } from "zod";
import { GatewayCertificateMonitor } from "./gateway-certificate-monitor.js";
import { gatewayRecoveryReceiptStatus } from "./gateway-recovery-status.js";
import { probePublicMcp as defaultPublicProbe } from "./management-probe.js";
import { GatewayGoogleWeb } from "./google-gateway-web.js";
import { GatewayAccountLink } from "./gateway-account-link.js";
import { GatewaySignupClient, type GatewaySignupPending } from "./gateway-signup-client.js";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { bindingOrigin } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";
import { installationRelayUrl } from "./installation-relay.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import {
  GatewayUnregistered,
  prepareGatewayOwner,
  registerGatewayKey,
} from "./gateway-key-client.js";
import { createGatewayAcmeController } from "./acme-integration.js";
import {
  GATEWAY_RELEASE_DAYS,
  gatewayReleaseSchema,
  releaseGateway,
  type GatewayRelease,
} from "./gateway-release.js";
import { startGatewayCloudTunnel } from "./gateway-integration.js";
import { HostedNameTaken, relayPublicConfiguration } from "./relay-configuration.js";
import {
  CloudRelayManagementFailure,
  type CloudRelayManagement,
  type CloudRelayManagementStatus,
  type CloudRelayConfigureInput,
  type CloudRelayNetworkIdentity,
  type CloudRelayManagementError,
} from "./management.js";

const log = createLogger("cloud-relay:management");

const PROBE_RETRIES = 20;

const settingsSchema = z
  .object({
    version: z.literal(1),
    gatewayId: z.string().uuid(),
    enabled: z.boolean(),
    relayUrl: z.string().max(2048),
    publicOrigin: z.string().max(2048),
    acmeDirectoryUrl: z.string().max(2048),
    termsAccepted: z.boolean(),
    invitationRequired: z.boolean(),
    legacyEnvironment: z.record(z.string(), z.string()).optional(),
  })
  .strict();
type Settings = z.infer<typeof settingsSchema>;
const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
type AcmeController = NonNullable<Awaited<ReturnType<typeof createGatewayAcmeController>>>;
type Tunnel = NonNullable<ReturnType<typeof startGatewayCloudTunnel>>;
export interface CloudRelayManagerOptions {
  certificateMonitor?: Pick<GatewayCertificateMonitor, "start" | "status" | "close">;
  googleCallbackOrigins?(): import("./google-browser-callback.js").GoogleBrowserCallbackOrigins;
  configDir: string;
  env: NodeJS.ProcessEnv;
  gatewayUrl(): string;
  activate(
    material: { hostname: string; cert: string; key: string },
    signal: AbortSignal,
  ): Promise<void>;
  directIdentity(): CloudRelayNetworkIdentity;
  directCertificateCoversHostname(hostname: string): boolean;
  /** The SPKI of the certificate served for the public name, including when it isn't managed here. */
  publicSpkiFingerprint?(): string | undefined;
  fetch?: typeof fetch;
  stopLegacy?(): Promise<void>;
  controller?: typeof createGatewayAcmeController;
  startTunnel?: typeof startGatewayCloudTunnel;
  register?: typeof registerGatewayKey;
  prepare?: typeof prepareGatewayOwner;
  discover?: typeof relayPublicConfiguration;
  probe?(origin: string, signal: AbortSignal): Promise<boolean>;
  /** How long to wait before checking the public address again after a failed check. */
  probeRetryMs?: number;
  /** How long to wait before asking the relay again to drop a gateway its owner disconnected. */
  releaseRetryMs?: number;
}

/** Persistent gateway-local control plane. Constructing an unconfigured manager creates no files or jobs. */
export class GatewayCloudRelayManagement implements CloudRelayManagement {
  private settings: Settings | undefined;
  private revision = 0;
  private busy = false;
  private enrollment: CloudRelayManagementStatus["enrollment"] = { state: "unconfigured" };
  private certificateError: CloudRelayManagementError | undefined;
  private publicReady = false;
  private publicError: "public-endpoint-unreachable" | undefined;
  private fingerprint: string | undefined;
  private spkiFingerprint: string | undefined;
  private lastRenewedAt: string | undefined;
  private controller: AcmeController | undefined;
  private tunnel: Tunnel | undefined;
  private pending: Promise<void> | undefined;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private registrationRetries = 0;
  private google: GatewayGoogleWeb | undefined;
  private account: GatewayAccountLink | undefined;
  private connection: NonNullable<CloudRelayManagementStatus["connect"]> = { state: "idle" };
  private signup: { client: GatewaySignupClient; pending: GatewaySignupPending } | undefined;
  private connectAbort = new AbortController();
  private notice: CloudRelayManagementStatus["notice"];
  private forgetting: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly monitor: Pick<GatewayCertificateMonitor, "start" | "status" | "close">;
  private readonly directory: string;
  private readonly file: string;
  private constructor(private readonly options: CloudRelayManagerOptions) {
    this.monitor =
      options.certificateMonitor ??
      new GatewayCertificateMonitor({
        env: options.env,
        configDir: options.configDir,
        identity: () => ({
          publicOrigin: this.publicOrigin(),
          spkiFingerprint: this.spkiFingerprintSha256(),
        }),
      });
    this.directory = join(options.configDir, "cloud-relay");
    this.file = join(this.directory, "management.json");
  }
  static async open(options: CloudRelayManagerOptions): Promise<GatewayCloudRelayManagement> {
    const manager = new GatewayCloudRelayManagement(options);
    try {
      manager.settings = settingsSchema.parse(await readPrivateJson(manager.file));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    if (
      !manager.settings &&
      options.env.OMNESIS_CLOUD_RELAY_URL &&
      options.env.OMNESIS_CLOUD_RELAY_GATEWAY_ID
    ) {
      const e = options.env;
      const names = [
        "OMNESIS_CLOUD_RELAY_URL",
        "OMNESIS_CLOUD_RELAY_GATEWAY_ID",
        "OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN",
        "OMNESIS_CLOUD_RELAY_SESSION_FILE",
        "OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE",
        "OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE",
        "OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE",
        "OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID",
        "OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE",
        "OMNESIS_PUBLIC_BASE_URL",
        "OMNESIS_TLS_CERT",
        "OMNESIS_TLS_KEY",
        "OMNESIS_ACME_DIRECTORY_URL",
        "OMNESIS_ACME_TERMS_ACCEPTED",
        "OMNESIS_ACME_CERT_FILE",
        "OMNESIS_ACME_KEY_FILE",
        "OMNESIS_ACME_ACCOUNT_KEY_FILE",
        "OMNESIS_ACME_DNS_PROVIDER",
        "OMNESIS_ACME_DNS_ZONE_ID",
        "OMNESIS_ACME_DNS_ZONE_NAME",
        "OMNESIS_ACME_DNS_TOKEN_FILE",
      ];
      manager.settings = settingsSchema.parse({
        version: 1,
        gatewayId: e.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
        enabled: true,
        relayUrl: relayOrigin(e.OMNESIS_CLOUD_RELAY_URL!).origin,
        publicOrigin: bindingOrigin(
          e.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN ?? e.OMNESIS_PUBLIC_BASE_URL!,
        ).origin,
        acmeDirectoryUrl: e.OMNESIS_ACME_DIRECTORY_URL ?? "",
        termsAccepted: e.OMNESIS_ACME_DIRECTORY_URL ? e.OMNESIS_ACME_TERMS_ACCEPTED === "1" : true,
        invitationRequired: true,
        legacyEnvironment: Object.fromEntries(
          names.filter((name) => e[name] !== undefined).map((name) => [name, e[name]!]),
        ),
      });
    }
    manager.google = new GatewayGoogleWeb({
      env: () => (manager.settings ? manager.environment() : options.env),
      metadataFile: join(manager.directory, "google-link.json"),
      callbackOrigins: options.googleCallbackOrigins,
      fetch: options.fetch,
      register: options.register,
    });
    await manager.google.initialize();
    manager.account = new GatewayAccountLink({
      env: () => (manager.settings ? manager.environment() : options.env),
      metadataFile: join(manager.directory, "account-link.json"),
      callbackOrigins: options.googleCallbackOrigins,
      fetch: options.fetch,
      register: options.register,
      // Devices sign for the key they were shown, which is whichever certificate serves the public name.
      spkiFingerprint: () => options.publicSpkiFingerprint?.() ?? manager.spkiFingerprintSha256(),
    });
    await manager.account.initialize();
    if (manager.settings && !manager.settings.enabled && manager.managesPublicCertificate()) {
      try {
        manager.requireSeparateHostname(manager.settings);
        const e = manager.environment(),
          cert = await readFile(publicGatewayCertificateFile(e), "utf8"),
          key = await readFile(publicGatewayPrivateKeyFile(e), "utf8");
        // Served whatever its dates: devices that pinned its key still reach the gateway at home
        // under this name, and nothing renews it while the gateway is not connected.
        const leaf = new X509Certificate(cert);
        if (
          leaf.checkHost(new URL(manager.settings.publicOrigin).hostname, {
            subject: "never",
            wildcards: false,
          }) !== new URL(manager.settings.publicOrigin).hostname
        )
          throw new Error();
        await options.activate(
          { hostname: new URL(manager.settings.publicOrigin).hostname, cert, key },
          AbortSignal.timeout(5000),
        );
        manager.fingerprint = leaf.fingerprint256.replaceAll(":", "").toLowerCase();
        manager.spkiFingerprint = (await import("./pinned-key.js")).tlsSpkiFingerprint(cert);
      } catch {
        manager.certificateError = "certificate-setup-failed";
      }
    }
    // The listener must be ready before a persisted enabled configuration starts.
    return manager;
  }
  start(): void {
    this.monitor.start();
    void this.release();
    this.launch();
  }
  isExposing(): boolean {
    return Boolean(this.settings?.enabled || this.tunnel || this.pending);
  }
  hasSavedConfiguration(): boolean {
    return this.settings !== undefined;
  }
  managesPublicCertificate(): boolean {
    return Boolean(this.settings?.acmeDirectoryUrl);
  }
  publicOrigin(): string | undefined {
    return this.settings?.publicOrigin;
  }
  fingerprintSha256(): string | undefined {
    return this.controller?.fingerprintSha256() ?? this.fingerprint;
  }
  spkiFingerprintSha256(): string | undefined {
    return this.controller?.spkiFingerprintSha256() ?? this.spkiFingerprint;
  }
  private environment(): NodeJS.ProcessEnv {
    const s = this.settings!;
    if (s.legacyEnvironment)
      return {
        ...this.options.env,
        ...s.legacyEnvironment,
        OMNESIS_ACME_DIRECTORY_URL: s.acmeDirectoryUrl || undefined,
        OMNESIS_ACME_TERMS_ACCEPTED: s.termsAccepted ? "1" : "0",
      };
    return {
      ...this.options.env,
      OMNESIS_CLOUD_RELAY_URL: s.relayUrl,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: s.gatewayId,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: s.publicOrigin,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: join(this.directory, "session.json"),
      OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: join(this.directory, "owner.key"),
      OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: join(this.directory, "invitation.json"),
      OMNESIS_ACME_DIRECTORY_URL: s.acmeDirectoryUrl,
      OMNESIS_ACME_TERMS_ACCEPTED: s.termsAccepted ? "1" : "0",
      OMNESIS_ACME_CERT_FILE: join(this.directory, "public.pem"),
      OMNESIS_ACME_KEY_FILE: join(this.directory, "public.key"),
      OMNESIS_ACME_ACCOUNT_KEY_FILE: join(this.directory, "acme-account.key"),
    };
  }
  private keyOptions(signal?: AbortSignal) {
    const e = this.environment();
    return {
      relayUrl: e.OMNESIS_CLOUD_RELAY_URL!,
      gatewayId: e.OMNESIS_CLOUD_RELAY_GATEWAY_ID!,
      publicOrigin: publicGatewayOrigin(e),
      sessionFile: e.OMNESIS_CLOUD_RELAY_SESSION_FILE!,
      ownerKeyFile: e.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!,
      certificateFile: publicGatewayCertificateFile(e),
      privateKeyFile: publicGatewayPrivateKeyFile(e),
      enrollmentTokenFile: e.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE!,
      recoveryReceiptFile: e.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
      fetch: this.options.fetch,
      signal,
    };
  }
  /**
   * The certificate directory a connect uses when the request names none: the
   * operator's `OMNESIS_ACME_DIRECTORY_URL` (a staging or private CA), else
   * Let's Encrypt production.
   */
  private defaultAcmeDirectoryUrl(): string {
    return this.options.env.OMNESIS_ACME_DIRECTORY_URL || LETS_ENCRYPT_DIRECTORY;
  }
  private requireSeparateHostname(settings: Settings): void {
    if (
      !(settings.legacyEnvironment && !settings.acmeDirectoryUrl) &&
      this.options.directCertificateCoversHostname(new URL(settings.publicOrigin).hostname)
    )
      throw new CloudRelayManagementFailure(400, "hostname-conflict");
  }
  private async persist(): Promise<void> {
    await savePrivateJson(this.file, this.settings);
    this.revision++;
  }
  private serviceError(): CloudRelayManagementStatus["serviceError"] {
    const selected = installationRelayUrl(this.options.env, this.settings?.relayUrl);
    if (!selected) return "relay-service-unavailable";
    if (this.settings && selected !== this.settings.relayUrl) return "relay-service-mismatch";
    return undefined;
  }
  async configure(input: CloudRelayConfigureInput): Promise<CloudRelayManagementStatus> {
    if (this.busy || this.settings?.enabled)
      throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.busy = true;
    try {
      const serviceError = this.serviceError();
      if (serviceError)
        throw new CloudRelayManagementFailure(
          serviceError === "relay-service-mismatch" ? 400 : 503,
          serviceError,
        );
      const relayUrl = installationRelayUrl(this.options.env, this.settings?.relayUrl)!;
      let custom: string | undefined, acmeDirectoryUrl: string;
      try {
        if (input.relayUrl !== undefined && relayOrigin(input.relayUrl).origin !== relayUrl)
          throw new CloudRelayManagementFailure(400, "relay-service-mismatch");
        custom = input.publicOrigin ? bindingOrigin(input.publicOrigin).origin : undefined;
        const directory = new URL(input.acmeDirectoryUrl ?? this.defaultAcmeDirectoryUrl());
        relayOrigin(directory.origin);
        if (directory.username || directory.password || directory.hash || directory.search)
          throw new Error();
        acmeDirectoryUrl = directory.href;
      } catch (error) {
        if (error instanceof CloudRelayManagementFailure) throw error;
        throw new CloudRelayManagementFailure(400, "configuration-invalid");
      }
      let gatewayId = this.settings?.gatewayId ?? randomUUID();
      let metadata;
      for (let attempt = 1; metadata === undefined; attempt++) {
        try {
          metadata = await (this.options.discover ?? relayPublicConfiguration)(
            relayUrl,
            gatewayId,
            AbortSignal.timeout(5000),
            this.options.fetch,
          );
        } catch (error) {
          // A new gateway's id is only a random draw, so a taken hosted name costs a redraw.
          if (!(error instanceof HostedNameTaken) || this.settings || attempt === 5)
            throw new CloudRelayManagementFailure(503, "relay-unreachable");
          gatewayId = randomUUID();
        }
      }
      const publicOrigin = custom ?? metadata.publicOrigin;
      if (!publicOrigin) throw new CloudRelayManagementFailure(400, "hostname-required");
      // Once a public identity exists, changing its network identity requires an explicit new installation.
      if (
        this.settings &&
        (this.settings.relayUrl !== relayUrl || this.settings.publicOrigin !== publicOrigin)
      )
        throw new CloudRelayManagementFailure(409, "configuration-invalid");
      const next: Settings = {
        ...(this.settings?.legacyEnvironment
          ? { legacyEnvironment: this.settings.legacyEnvironment }
          : {}),
        version: 1,
        gatewayId,
        relayUrl,
        publicOrigin: bindingOrigin(publicOrigin).origin,
        acmeDirectoryUrl,
        termsAccepted: input.termsAccepted ?? false,
        invitationRequired: metadata.invitationRequired,
        enabled: false,
      };
      this.requireSeparateHostname(next);
      if (!next.legacyEnvironment)
        await (this.options.prepare ?? prepareGatewayOwner)({
          gatewayId,
          sessionFile: join(this.directory, "session.json"),
          ownerKeyFile: join(this.directory, "owner.key"),
          publicOrigin,
        });
      const previous = this.settings;
      this.settings = next;
      try {
        await this.persist();
      } catch (error) {
        this.settings = previous;
        throw error;
      }
      this.enrollment = { state: "pending" };
    } finally {
      this.busy = false;
    }
    return this.status();
  }
  async enable(input: { invitation?: string } = {}): Promise<CloudRelayManagementStatus> {
    return this.control(async () => {
      if (!this.settings) throw new CloudRelayManagementFailure(400, "configuration-invalid");
      this.requireSeparateHostname(this.settings);
      if (!this.settings.termsAccepted)
        throw new CloudRelayManagementFailure(400, "ca-terms-required");
      // The gateway keeps its id, so it must be out of its old account before it registers again.
      await this.release();
      if (existsSync(this.releaseFile))
        throw new CloudRelayManagementFailure(503, "relay-unreachable");
      if (input.invitation !== undefined) {
        if (!input.invitation || input.invitation.length > 4096)
          throw new CloudRelayManagementFailure(400, "configuration-invalid");
        await savePrivateJson(
          this.environment().OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE ??
            join(this.directory, "invitation.json"),
          { enrollmentToken: input.invitation },
        );
      }
      if (
        this.settings.invitationRequired &&
        !input.invitation &&
        !this.settings.legacyEnvironment
      ) {
        try {
          await access(this.environment().OMNESIS_CLOUD_RELAY_SESSION_FILE!);
        } catch {
          try {
            await access(this.environment().OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE!);
          } catch {
            throw new CloudRelayManagementFailure(400, "invitation-required");
          }
        }
      }
      const previouslyEnabled = this.settings.enabled;
      this.settings.enabled = true;
      try {
        await this.persist();
      } catch (error) {
        this.settings.enabled = previouslyEnabled;
        throw error;
      }
      this.launch();
    });
  }
  private launch(force = false): void {
    if (this.pending || !this.settings?.enabled) return;
    clearTimeout(this.timer);
    // Ends a recheck still in flight, so it cannot write over what this launch finds.
    this.abort.abort();
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(150_000)]);
    this.notice = undefined;
    this.pending = (async () => {
      let unregistered = false;
      this.enrollment = { state: "pending" };
      this.revision++;
      try {
        this.requireSeparateHostname(this.settings!);
        await this.options.stopLegacy?.();
        signal.throwIfAborted();
        this.controller ??= await (this.options.controller ?? createGatewayAcmeController)(
          this.environment(),
          {
            configDir: this.options.configDir,
            activate: this.options.activate,
            fetch: this.options.fetch,
          },
        );
        this.monitor.start();
        if (!this.controller && !this.settings!.legacyEnvironment)
          throw new Error("Certificate controller unavailable");
        if (this.controller)
          await (this.options.register ?? registerGatewayKey)(this.keyOptions(signal));
        signal.throwIfAborted();
        this.enrollment = { state: "enrolled" };
        this.registrationRetries = 0;
        // A refusal the relay has since lifted must not keep the Relay page on the old failure.
        if (this.connection.state === "failed" && this.connection.error === "enrollment-refused")
          this.connection = { state: "idle" };
        await this.google!.refreshManaged(signal);
        await this.account!.refresh(signal);
        signal.throwIfAborted();
        this.tunnel ??= (this.options.startTunnel ?? startGatewayCloudTunnel)(
          this.options.gatewayUrl(),
          this.environment(),
          () => this.forgotten(),
        );
        if (force || !this.publicReady) {
          if (await this.controller?.renew(signal)) this.lastRenewedAt = new Date().toISOString();
        }
        signal.throwIfAborted();
        this.certificateError = undefined;
        this.publicReady = await this.reachable(signal);
        // A first miss is not an error yet: the address is looked at again for a few minutes.
        if (this.publicReady) this.publicError = undefined;
      } catch (error) {
        if (!this.abort.signal.aborted) {
          unregistered = error instanceof GatewayUnregistered;
          // The page only shows a code; the reason has to be findable in the gateway log.
          log.warn(`Connecting to the relay failed: ${String(error)}`);
          if (this.enrollment.state !== "enrolled")
            this.enrollment = {
              state: "failed",
              error:
                error instanceof CloudRelayManagementFailure ? error.code : "enrollment-refused",
            };
          else this.certificateError = "certificate-renewal-failed";
          this.publicReady = false;
        }
      } finally {
        this.pending = undefined;
        this.revision++;
        if (unregistered) this.forgotten();
        else if (this.settings?.enabled && !this.abort.signal.aborted) this.scheduleNext(0);
      }
    })();
  }
  /**
   * The first check runs the moment the tunnel is started, usually before it is online. Without a
   * prompt second look the Relay page would call a working address unreachable for an hour.
   */
  private scheduleNext(attempt: number): void {
    const soon = this.options.probeRetryMs ?? 15_000;
    if (this.enrollment.state !== "enrolled" && this.registrationRetries < PROBE_RETRIES) {
      // A registration that failed is tried again by itself: one hiccup must not cost an hour.
      this.registrationRetries++;
      this.timer = setTimeout(() => this.launch(true), soon);
    } else {
      const recheck = !this.publicReady && attempt < PROBE_RETRIES;
      if (!this.publicReady && !recheck) {
        this.publicError = "public-endpoint-unreachable";
        this.revision++;
      }
      this.timer = recheck
        ? setTimeout(() => void this.recheck(attempt + 1), soon)
        : setTimeout(() => this.launch(true), 60 * 60_000);
    }
    this.timer.unref();
  }
  private reachable(signal: AbortSignal): Promise<boolean> {
    return (this.options.probe ?? defaultPublicProbe)(this.settings!.publicOrigin, signal).catch(
      () => false,
    );
  }
  private async recheck(attempt: number): Promise<void> {
    const abort = this.abort;
    const ready = await this.reachable(abort.signal);
    // A stop or a newer launch owns the state from here.
    if (abort.signal.aborted) return;
    if (ready) {
      this.publicReady = true;
      this.publicError = undefined;
      this.revision++;
    }
    this.scheduleNext(attempt);
  }
  private async stop(): Promise<void> {
    this.abort.abort();
    this.google?.cancel();
    this.account?.cancel();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.tunnel?.stop();
    this.tunnel = undefined;
    await this.pending;
    this.fingerprint = this.fingerprintSha256();
    this.spkiFingerprint = this.spkiFingerprintSha256();
    await this.controller?.close();
    this.controller = undefined;
    this.publicReady = false;
    await this.options.stopLegacy?.();
  }
  /**
   * The relay answered this gateway's own proven keys that it has no registration for it: its
   * Omnesis account was deleted. The gateway leaves as if its owner had disconnected it, so it
   * can be connected to another account. Devices already paired stay paired: they belong to
   * the gateway. Nothing else the relay says, and no failure to reach it, leads here.
   */
  private forgotten(): void {
    this.forgetting ??= this.forget()
      .catch((error: unknown) => log.warn(`Leaving the deleted account failed: ${String(error)}`))
      .finally(() => (this.forgetting = undefined));
  }
  private async forget(): Promise<void> {
    // A late word from a tunnel that is already stopped changes nothing.
    if (!this.settings!.enabled) return;
    log.warn("The relay no longer has this gateway: its Omnesis account was deleted");
    await this.leave(false);
    this.notice = "account-deleted";
    this.revision++;
  }
  private get releaseFile(): string {
    return join(this.directory, "release.json");
  }
  /**
   * Out of its account and off the relay: remote access off, the account link with its policy and
   * trusted sign-ins gone, and the relay session, invitation and recovery receipt removed.
   *
   * The gateway id, the public certificate and its key stay, and the listener keeps answering
   * for the public name with them. Devices that joined by signing in pinned that key and reach
   * the gateway under that name at home, so they keep working; and a gateway that connects again
   * asks for the same address with the same key. `departing` is the owner disconnecting a
   * gateway the relay still has, which the relay is then asked to drop.
   */
  private async leave(departing: boolean): Promise<void> {
    const settings = this.settings!,
      options = this.keyOptions();
    // A gateway that never registered has nothing on the relay to drop.
    const release = departing && existsSync(options.sessionFile);
    this.connectAbort.abort();
    this.signup = undefined;
    this.connection = { state: "idle" };
    await this.stop();
    await this.account!.forget();
    await this.google!.forget();
    // The session proves this gateway to the relay one last time; otherwise it is dead there.
    if (release)
      await savePrivateJson(this.releaseFile, {
        version: 1,
        relayUrl: options.relayUrl,
        gatewayId: options.gatewayId,
        publicOrigin: options.publicOrigin,
        sessionFile: options.sessionFile,
        ownerKeyFile: options.ownerKeyFile,
        certificateFile: options.certificateFile,
        privateKeyFile: options.privateKeyFile,
        createdAt: Date.now(),
      } satisfies GatewayRelease);
    else await rm(options.sessionFile, { force: true });
    for (const spent of [
      options.enrollmentTokenFile ?? join(this.directory, "invitation.json"),
      options.recoveryReceiptFile ?? `${options.sessionFile}.recovery.json`,
    ])
      await rm(spent, { force: true });
    settings.enabled = false;
    await this.persist();
    this.enrollment = { state: "unconfigured" };
    this.certificateError = this.publicError = this.lastRenewedAt = undefined;
    this.registrationRetries = 0;
  }
  /**
   * Asks the relay to drop the gateway its owner disconnected, until it has: the relay may have
   * been out of reach when the owner did. A relay that never answers is given up after a month.
   */
  private release(): Promise<void> {
    return (this.releasing ??= (async () => {
      clearTimeout(this.releaseTimer);
      let record: GatewayRelease;
      try {
        record = gatewayReleaseSchema.parse(await readPrivateJson(this.releaseFile));
      } catch {
        // Nothing is waiting, or what waits cannot be read and so cannot be acted on.
        await rm(this.releaseFile, { force: true });
        return;
      }
      try {
        if (record.createdAt > Date.now() - GATEWAY_RELEASE_DAYS * 86400_000)
          await releaseGateway(record, {
            register: this.options.register ?? registerGatewayKey,
            fetch: this.options.fetch,
            signal: AbortSignal.timeout(20_000),
          });
        await rm(record.sessionFile, { force: true });
        await rm(this.releaseFile, { force: true });
      } catch (error) {
        log.warn(`The relay has not dropped the disconnected gateway yet: ${String(error)}`);
        if (this.closed) return;
        this.releaseTimer = setTimeout(
          () => void this.release(),
          this.options.releaseRetryMs ?? 15 * 60_000,
        );
        this.releaseTimer.unref();
      }
    })().finally(() => (this.releasing = undefined)));
  }
  private async control(action: () => Promise<void>): Promise<CloudRelayManagementStatus> {
    if (this.busy) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.busy = true;
    try {
      await action();
    } finally {
      this.busy = false;
    }
    return this.status();
  }
  async disable(): Promise<CloudRelayManagementStatus> {
    return this.control(async () => {
      this.abort.abort();
      try {
        if (this.settings) {
          this.settings.enabled = false;
          await this.persist();
        }
      } finally {
        await this.stop();
      }
    });
  }
  async reconnect(): Promise<CloudRelayManagementStatus> {
    return this.control(async () => {
      if (!this.settings?.enabled)
        throw new CloudRelayManagementFailure(409, "configuration-invalid");
      await this.stop();
      this.launch();
    });
  }
  async renew(): Promise<CloudRelayManagementStatus> {
    return this.control(async () => {
      if (!this.settings?.enabled)
        throw new CloudRelayManagementFailure(409, "configuration-invalid");
      if (this.pending) throw new CloudRelayManagementFailure(409, "operation-in-progress");
      clearTimeout(this.timer);
      this.launch(true);
    });
  }
  async status(): Promise<CloudRelayManagementStatus> {
    const s = this.settings,
      direct = this.options.directIdentity();
    let certificate: CloudRelayManagementStatus["certificate"] = { state: "unconfigured" };
    if (s) {
      try {
        const cert = new X509Certificate(
          await readFile(
            this.environment().OMNESIS_ACME_CERT_FILE ??
              this.environment().OMNESIS_TLS_CERT ??
              join(this.directory, "public.pem"),
          ),
        );
        const expiry = Date.parse(cert.validTo);
        certificate = {
          state:
            expiry <= Date.now()
              ? "expired"
              : cert.checkIssued(cert)
                ? "bootstrap"
                : expiry - Date.now() < 30 * 86400_000
                  ? "expiring"
                  : "valid",
          expiresAt: new Date(expiry).toISOString(),
        };
      } catch {
        if (this.certificateError) certificate.state = "failed";
      }
    }
    certificate.lastError = this.certificateError;
    certificate.lastRenewedAt = this.lastRenewedAt;
    const cloud: CloudRelayNetworkIdentity = {
      id: "cloud",
      names: s ? [new URL(s.publicOrigin).hostname] : [],
      kind:
        certificate.state === "unconfigured"
          ? "unconfigured"
          : certificate.state === "bootstrap"
            ? "self-signed"
            : "public-ca",
      state: certificate.state === "bootstrap" ? "valid" : certificate.state,
      expiresAt: certificate.expiresAt,
      pinPolicy: "strict-key-pin-or-public-pki",
    };
    const tunnel = this.tunnel?.status();
    const e = s ? this.environment() : undefined;
    const recovery = s
      ? await gatewayRecoveryReceiptStatus({
          relayUrl: s.relayUrl,
          gatewayId: s.gatewayId,
          publicOrigin: s.publicOrigin,
          sessionFile: e!.OMNESIS_CLOUD_RELAY_SESSION_FILE ?? join(this.directory, "session.json"),
          ownerKeyFile: e!.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
          recoveryReceiptFile: e!.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
        })
      : undefined;
    return {
      certificateMonitor: this.monitor.status(),
      ...(recovery ? { recovery } : {}),
      revision: this.revision,
      enabled: s?.enabled ?? false,
      configured: Boolean(s),
      serviceConfigured: !this.serviceError(),
      serviceError: this.serviceError(),
      gatewayId: s?.gatewayId,
      hostname: s ? new URL(s.publicOrigin).hostname : undefined,
      publicOrigin: s?.publicOrigin,
      identities: [direct, cloud],
      directCertificate: { state: direct.state, expiresAt: direct.expiresAt },
      config: {
        relayUrl: s?.relayUrl ?? installationRelayUrl(this.options.env),
        publicOrigin: s?.publicOrigin,
        // Before the first connect, the directory a connect would use.
        acmeDirectoryUrl: s?.acmeDirectoryUrl || (s ? undefined : this.defaultAcmeDirectoryUrl()),
        // Terms are shown only for Let's Encrypt; another directory's operator states its own.
        acmeTermsUrl:
          (s ? s.acmeDirectoryUrl : this.defaultAcmeDirectoryUrl()) === LETS_ENCRYPT_DIRECTORY
            ? "https://letsencrypt.org/repository/"
            : undefined,
        termsAccepted: s?.termsAccepted ?? false,
        invitationRequired: s?.invitationRequired ?? true,
      },
      enrollment: { ...this.enrollment },
      tunnel: tunnel ?? { state: s?.enabled ? "connecting" : "disabled" },
      certificate,
      publicMcp: {
        lastError: this.publicError,
        ready: this.publicReady && tunnel?.state === "online",
        url: s ? `${s.publicOrigin}/mcp` : undefined,
      },
      google: {
        ...this.google!.status(),
        canLink:
          !this.account!.accountModeActivated() &&
          this.google!.status().configured &&
          Boolean(s?.enabled && this.enrollment.state === "enrolled"),
        canUnlink: this.google!.status().linked && Boolean(s),
      },
      account: {
        ...this.account!.status(),
        canLink:
          this.account!.status().canLink &&
          Boolean(s?.enabled && this.enrollment.state === "enrolled"),
      },
      ...(this.connection.state === "idle" ? {} : { connect: { ...this.connection } }),
      deviceEnrollment: this.account!.enrollmentStatus(),
      ...(this.notice ? { notice: this.notice } : {}),
      can: {
        configure: !this.serviceError() && !this.busy && !s?.enabled,
        enable: Boolean(s && !s.enabled),
        disable: Boolean(s?.enabled),
        reconnect: Boolean(s?.enabled && !this.pending),
        renew: Boolean(s?.enabled && !this.pending),
      },
    };
  }
  managedGoogleBrowser() {
    return this.settings?.enabled && this.enrollment.state === "enrolled"
      ? this.google!.managedBrowser()
      : undefined;
  }
  managedAccountBrowser() {
    return this.settings?.enabled && this.enrollment.state === "enrolled"
      ? this.account!.managedBrowser()
      : undefined;
  }
  accountModeActivated(): boolean {
    return this.account!.accountModeActivated();
  }
  accountPairingIdentity() {
    return this.account!.pairingIdentity();
  }
  /**
   * Configure, register and link from one sign-in. The relay's answer only supplies an
   * invitation and an account; the gateway still proves its own keys and checks the link.
   */
  async connect(input: {
    termsAccepted: boolean;
    intent?: "create" | "existing";
  }): Promise<CloudRelayManagementStatus> {
    if (!input.termsAccepted) throw new CloudRelayManagementFailure(400, "ca-terms-required");
    if (["waiting", "registering", "linking"].includes(this.connection.state)) return this.status();
    this.notice = undefined;
    // A gateway named by its environment is already configured, by its operator.
    if (!this.settings || !(this.settings.enabled || this.settings.legacyEnvironment))
      await this.configure({ termsAccepted: true });
    const env = this.environment();
    const client = new GatewaySignupClient({
      relayUrl: this.settings!.relayUrl,
      gatewayId: this.settings!.gatewayId,
      ownerKeyFile: env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE!,
      fetch: this.options.fetch,
    });
    this.connectAbort = new AbortController();
    let pending: GatewaySignupPending;
    try {
      pending = await client.start(this.connectAbort.signal, input.intent);
    } catch {
      throw new CloudRelayManagementFailure(503, "relay-unreachable");
    }
    this.signup = { client, pending };
    this.connection = {
      state: "waiting",
      authorizeUrl: pending.authorizeUrl,
      connectUrl: pending.connectUrl,
      ...(pending.connectShortUrl ? { connectShortUrl: pending.connectShortUrl } : {}),
      code: pending.code,
      expiresAt: pending.expiresAt,
    };
    this.revision++;
    void this.finishConnect(client, pending, this.connectAbort.signal);
    return this.status();
  }
  private async finishConnect(
    client: GatewaySignupClient,
    pending: GatewaySignupPending,
    signal: AbortSignal,
  ): Promise<void> {
    const fail = (error: NonNullable<CloudRelayManagementStatus["connect"]>["error"]) => {
      if (signal.aborted) return;
      this.connection = { state: "failed", error };
      this.signup = undefined;
      this.revision++;
    };
    let approved;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (pending.expiresAt * 1000 <= Date.now()) return fail("expired");
        const result = await client.poll(pending, signal).catch(() => undefined);
        if (result?.status === "denied") return fail(result.reason);
        if (result?.status === "approved") {
          approved = result;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000).unref());
      }
      this.connection = { state: "registering" };
      this.revision++;
      if (!this.settings!.enabled || this.enrollment.state !== "enrolled") {
        await savePrivateJson(this.environment().OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE!, {
          enrollmentToken: approved.enrollmentToken,
        });
        // An earlier attempt may have left the relay turned on but never registered.
        if (this.settings!.enabled) this.launch(true);
        else await this.enable();
      }
      await this.pending;
      signal.throwIfAborted();
      if (this.enrollment.state !== "enrolled") return fail("enrollment-refused");
      this.connection = { state: "linking" };
      this.revision++;
      const accountId = await client.link(
        pending,
        this.options.register ?? registerGatewayKey,
        this.keyOptions(signal),
      );
      if (accountId !== approved.accountId) return fail("account-link-failed");
      await this.account!.completeSignup({
        accountId,
        nonce: pending.nonce,
        proof: approved.signInProof,
        ...(approved.credentialPublicKey
          ? { credentialPublicKey: approved.credentialPublicKey }
          : {}),
        signal,
      });
      await this.account!.refresh(signal);
      this.connection = { state: "done" };
      this.signup = undefined;
      this.revision++;
    } catch {
      fail(this.enrollment.state === "enrolled" ? "account-link-failed" : "enrollment-refused");
    }
  }
  async cancelConnect(): Promise<CloudRelayManagementStatus> {
    this.connectAbort.abort();
    const signup = this.signup;
    this.signup = undefined;
    if (signup && this.connection.state === "waiting") await signup.client.cancel(signup.pending);
    this.connection = { state: "idle" };
    this.revision++;
    return this.status();
  }
  async setEnrollmentPolicy(policy: "automatic" | "ask"): Promise<CloudRelayManagementStatus> {
    await this.account!.setEnrollmentPolicy(policy);
    this.revision++;
    return this.status();
  }
  async removeTrustedSignIn(id: string): Promise<CloudRelayManagementStatus> {
    await this.account!.removeTrustedSignIn(id);
    this.revision++;
    return this.status();
  }
  verifiedAccountId(): string | undefined {
    return this.account!.verifiedAccountId();
  }
  async accountLink(input: { requestOrigin: string }) {
    if (!this.settings?.enabled || this.enrollment.state !== "enrolled")
      throw new CloudRelayManagementFailure(409, "configuration-invalid");
    return this.account!.start(input);
  }
  async accountCallback(input: { url: string; cookie?: string }) {
    return this.account!.callback(input);
  }
  /**
   * The owner disconnects this gateway: it leaves its account and can no longer be reached
   * through the relay, whether or not the relay can be told right now.
   */
  async accountUnlink(): Promise<CloudRelayManagementStatus> {
    if (!this.settings) throw new CloudRelayManagementFailure(409, "configuration-invalid");
    return this.control(async () => {
      await this.leave(true);
      await this.release();
      this.revision++;
    });
  }
  verifiedGoogleOwnerAccountId(): string | undefined {
    return this.google?.verifiedOwnerAccountId();
  }
  async googleLink(input: { requestOrigin: string }) {
    if (!this.settings?.enabled || this.account!.accountModeActivated())
      throw new CloudRelayManagementFailure(409, "configuration-invalid");
    return this.google!.start(input);
  }
  async googleCallback(input: { url: string; cookie?: string }) {
    return this.google!.callback(input);
  }
  async googleUnlink(): Promise<CloudRelayManagementStatus> {
    if (!this.settings) throw new CloudRelayManagementFailure(409, "configuration-invalid");
    await this.google!.unlink();
    this.revision++;
    return this.status();
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.releaseTimer);
    try {
      await this.monitor.close();
    } finally {
      await this.stop();
    }
  }
}

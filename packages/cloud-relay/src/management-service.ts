// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID, X509Certificate } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GatewayCertificateMonitor } from "./gateway-certificate-monitor.js";
import { gatewayRecoveryReceiptStatus } from "./gateway-recovery-status.js";
import { probePublicMcp as defaultPublicProbe } from "./management-probe.js";
import { GatewayGoogleWeb } from "./google-gateway-web.js";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { bindingOrigin, validateCertificateDates } from "./gateway-binding.js";
import { relayOrigin } from "./network.js";
import { installationRelayUrl } from "./installation-relay.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { prepareGatewayOwner, registerGatewayKey } from "./gateway-key-client.js";
import { createGatewayAcmeController } from "./acme-integration.js";
import { startGatewayCloudTunnel } from "./gateway-integration.js";
import { relayPublicConfiguration } from "./relay-configuration.js";
import {
  CloudRelayManagementFailure,
  type CloudRelayManagement,
  type CloudRelayManagementStatus,
  type CloudRelayConfigureInput,
  type CloudRelayNetworkIdentity,
  type CloudRelayManagementError,
} from "./management.js";

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
  fetch?: typeof fetch;
  stopLegacy?(): Promise<void>;
  controller?: typeof createGatewayAcmeController;
  startTunnel?: typeof startGatewayCloudTunnel;
  register?: typeof registerGatewayKey;
  prepare?: typeof prepareGatewayOwner;
  discover?: typeof relayPublicConfiguration;
  probe?(origin: string, signal: AbortSignal): Promise<boolean>;
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
  private google: GatewayGoogleWeb | undefined;
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
    if (manager.settings && !manager.settings.enabled && manager.managesPublicCertificate()) {
      try {
        manager.requireSeparateHostname(manager.settings);
        const e = manager.environment(),
          cert = await readFile(publicGatewayCertificateFile(e), "utf8"),
          key = await readFile(publicGatewayPrivateKeyFile(e), "utf8");
        const leaf = new X509Certificate(cert);
        validateCertificateDates(leaf);
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
        const directory = new URL(
          input.acmeDirectoryUrl ?? "https://acme-v02.api.letsencrypt.org/directory",
        );
        relayOrigin(directory.origin);
        if (directory.username || directory.password || directory.hash || directory.search)
          throw new Error();
        acmeDirectoryUrl = directory.href;
      } catch (error) {
        if (error instanceof CloudRelayManagementFailure) throw error;
        throw new CloudRelayManagementFailure(400, "configuration-invalid");
      }
      const gatewayId = this.settings?.gatewayId ?? randomUUID();
      let metadata;
      try {
        metadata = await (this.options.discover ?? relayPublicConfiguration)(
          relayUrl,
          gatewayId,
          AbortSignal.timeout(5000),
          this.options.fetch,
        );
      } catch {
        throw new CloudRelayManagementFailure(503, "relay-unreachable");
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
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(150_000)]);
    this.pending = (async () => {
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
        await this.google!.refreshManaged(signal);
        signal.throwIfAborted();
        this.tunnel ??= (this.options.startTunnel ?? startGatewayCloudTunnel)(
          this.options.gatewayUrl(),
          this.environment(),
        );
        if (force || !this.publicReady) {
          if (await this.controller?.renew(signal)) this.lastRenewedAt = new Date().toISOString();
        }
        signal.throwIfAborted();
        this.certificateError = undefined;
        try {
          this.publicReady = await (this.options.probe ?? defaultPublicProbe)(
            this.settings!.publicOrigin,
            signal,
          );
        } catch {
          this.publicReady = false;
        }
        this.publicError = this.publicReady ? undefined : "public-endpoint-unreachable";
      } catch (error) {
        if (!this.abort.signal.aborted) {
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
        if (this.settings?.enabled && !this.abort.signal.aborted) {
          this.timer = setTimeout(() => this.launch(true), 60 * 60_000);
          this.timer.unref();
        }
      }
    })();
  }
  private async stop(): Promise<void> {
    this.abort.abort();
    this.google?.cancel();
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
        acmeDirectoryUrl: s?.acmeDirectoryUrl,
        acmeTermsUrl:
          s?.acmeDirectoryUrl === "https://acme-v02.api.letsencrypt.org/directory"
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
          this.google!.status().configured &&
          Boolean(s?.enabled && this.enrollment.state === "enrolled"),
        canUnlink: this.google!.status().linked && Boolean(s),
      },
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
  verifiedGoogleOwnerAccountId(): string | undefined {
    return this.google?.verifiedOwnerAccountId();
  }
  async googleLink(input: { requestOrigin: string }) {
    if (!this.settings?.enabled)
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
    try {
      await this.monitor.close();
    } finally {
      await this.stop();
    }
  }
}

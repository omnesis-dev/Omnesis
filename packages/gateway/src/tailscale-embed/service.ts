// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's own tailnet device: the owner's settings, the helper program
 * that joins the tailnet, the private socket the helper forwards to, and the
 * collectors asking to join. Everything here exists only with
 * OMNESIS_TAILSCALE_EMBED_ENABLED=1.
 */

import { join } from "node:path";
import { createLogger, type TailscaleAdminState, type TailscaleJoinPolicy } from "@omnesis/core";
import { PUBLIC_PATHS } from "./caller.js";
import { resolveHelperBinary, type HelperBinary } from "./helper-binary.js";
import { TailscaleJoinRequests, type JoinRequestDeps } from "./join-requests.js";
import { tailscaleDir, TailscaleSettingsStore, type TailscaleSettings } from "./settings.js";
import {
  startTailnetSocketServer,
  tailnetSocketPath,
  type RequestListener,
  type TailnetSocketServer,
} from "./socket-server.js";
import { HelperSupervisor, type SupervisorSnapshot } from "./supervisor.js";
import type { HelperStatus } from "./protocol.js";
import type { Duplex } from "node:stream";
import type { IncomingMessage, Server } from "node:http";

const log = createLogger("gateway:tailscale");

/** How joining collectors get their credentials; bound by the server to the pairing service. */
export type Admission = Pick<JoinRequestDeps, "admit" | "revokedAt">;

export interface TailscaleServiceOptions {
  configDir: string;
  /** The gateway's own certificate files, served when Tailscale's cannot be. */
  tlsMaterial: () => { cert: string; key: string };
  /** Notifications for join requests; admission is bound later with `useAdmission`. */
  joins: Pick<JoinRequestDeps, "notifyWaiting" | "notifyJoined">;
  env?: NodeJS.ProcessEnv;
  supervisor?: HelperSupervisor;
  resolveBinary?: () => HelperBinary;
  /** Called whenever anything the state reports changes. */
  onChange?: () => void;
}

interface AttachedApp {
  listener: RequestListener;
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  onServer?: (server: Server) => void;
}

export class TailscaleEmbedService {
  readonly settings: TailscaleSettingsStore;
  readonly joins: TailscaleJoinRequests;
  private readonly supervisor: HelperSupervisor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveBinary: () => HelperBinary;
  private app: AttachedApp | null = null;
  private socket: TailnetSocketServer | null = null;
  private unavailable: string | undefined;
  private lastLogged = "";
  private admission: Admission | null = null;
  /** Starts and stops run one at a time, in the order they were asked for. */
  private lifecycle: Promise<void> = Promise.resolve();
  /** Set by shutdown; nothing starts the device again afterwards. */
  private closed = false;

  constructor(private readonly options: TailscaleServiceOptions) {
    this.env = options.env ?? process.env;
    this.settings = new TailscaleSettingsStore(options.configDir);
    this.joins = new TailscaleJoinRequests({
      ...options.joins,
      admit: (input) =>
        this.admission
          ? this.admission.admit(input)
          : Promise.resolve({
              outcome: "failed",
              error: "The gateway is still starting. Try again.",
            }),
      // Until admission is bound every machine counts as held back: nothing joins.
      revokedAt: (identity) =>
        this.admission ? this.admission.revokedAt(identity) : Number.MAX_SAFE_INTEGER,
    });
    this.supervisor = options.supervisor ?? new HelperSupervisor(undefined, this.env);
    this.resolveBinary = options.resolveBinary ?? (() => resolveHelperBinary(this.env));
    this.supervisor.onChange((snapshot) => this.onHelperChange(snapshot));
  }

  private get featureDir(): string {
    return tailscaleDir(this.options.configDir);
  }

  /**
   * How an admitted collector gets its credentials: the server binds the same
   * pairing-code redemption every pairing goes through.
   */
  useAdmission(admission: Admission): void {
    this.admission = admission;
  }

  /** Give the service the app to serve; starts the device if the owner left it on. */
  async attach(app: AttachedApp): Promise<void> {
    this.app = app;
    if (this.settings.get().enabled) await this.serial(() => this.start(false));
  }

  async setEnabled(enabled: boolean): Promise<TailscaleAdminState> {
    this.settings.update({ enabled });
    await this.serial(() => (enabled ? this.start(false) : this.stopDevice()));
    return this.state();
  }

  async updateSettings(patch: {
    publicAccess?: boolean;
    joinPolicy?: TailscaleJoinPolicy;
    deviceName?: string;
  }): Promise<TailscaleAdminState> {
    const before = this.settings.get();
    const after = this.settings.update(patch);
    if (after.publicAccess !== before.publicAccess) this.configure(after);
    // The device name is fixed when the helper starts; a new one needs a restart.
    if (after.deviceName !== before.deviceName && after.enabled)
      await this.serial(() => this.start(true));
    this.options.onChange?.();
    return this.state();
  }

  signIn(): TailscaleAdminState {
    this.supervisor.send({ type: "login" });
    return this.state();
  }

  signOut(): TailscaleAdminState {
    this.supervisor.send({ type: "logout" });
    return this.state();
  }

  /** The gateway's HTTPS origin on the tailnet, while its device is connected. */
  tailnetOrigin(): string | null {
    const status = this.helperStatus();
    return status?.backend === "running" && status.node ? `https://${status.node.dnsName}` : null;
  }

  /** Whether phones can verify the tailnet origin through platform trust. */
  tailnetCertificateTrusted(): boolean {
    return this.helperStatus()?.certificate.source === "tailscale";
  }

  /** The public origin cloud agents use, while the public address is on. */
  publicOrigin(): string | null {
    const status = this.helperStatus();
    return status?.public.state === "on" && status.node ? `https://${status.node.dnsName}` : null;
  }

  joinPolicy(): TailscaleJoinPolicy {
    return this.settings.get().joinPolicy;
  }

  state(): TailscaleAdminState {
    const settings = this.settings.get();
    const snapshot = this.supervisor.snapshot();
    const status = snapshot.status;
    return {
      enabled: settings.enabled,
      deviceName: settings.deviceName,
      joinPolicy: settings.joinPolicy,
      helper: this.helperState(settings, snapshot),
      connection: this.connection(settings, status),
      signInUrl: status?.backend === "needs-login" ? (status.loginUrl ?? null) : null,
      url: this.tailnetOrigin(),
      node:
        status?.backend === "running" && status.node
          ? {
              dnsName: status.node.dnsName,
              ...(status.node.tailnet ? { tailnet: status.node.tailnet } : {}),
              ips: status.node.ips,
            }
          : null,
      owner:
        status?.backend === "running" && status.owner
          ? {
              login: status.owner.login,
              ...(status.owner.displayName ? { displayName: status.owner.displayName } : {}),
            }
          : null,
      certificate: status?.backend === "running" ? status.certificate : null,
      public: {
        wanted: settings.publicAccess,
        ...(status ? status.public : { state: "off" as const }),
      },
      joinRequests: this.joins.list(),
    };
  }

  /**
   * Stop for the gateway's shutdown; the owner's settings stay as they are.
   * Requests already forwarded get up to `drainMs` to finish before the
   * helper, and with it the tailnet and public addresses, goes.
   */
  async shutdown(drainMs = 0): Promise<void> {
    this.closed = true;
    await this.serial(async () => {
      const socket = this.socket;
      this.socket = null;
      await socket?.close(drainMs);
      await this.supervisor.stop();
    });
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(step, step);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private helperStatus(): HelperStatus | null {
    return this.supervisor.snapshot().status;
  }

  private helperState(
    settings: TailscaleSettings,
    snapshot: SupervisorSnapshot,
  ): TailscaleAdminState["helper"] {
    if (!settings.enabled) return { state: "off" };
    if (this.unavailable) return { state: "unavailable", reason: this.unavailable };
    switch (snapshot.process) {
      case "running":
        return { state: "running" };
      case "crashed":
        return { state: "restarting", ...(snapshot.reason ? { reason: snapshot.reason } : {}) };
      default:
        return { state: "starting" };
    }
  }

  private connection(
    settings: TailscaleSettings,
    status: HelperStatus | null,
  ): TailscaleAdminState["connection"] {
    if (!settings.enabled) return "off";
    switch (status?.backend) {
      case "needs-login":
        return "needs-sign-in";
      case "needs-approval":
        return "needs-approval";
      case "running":
        return "connected";
      case "stopped":
        return "stopped";
      default:
        return "starting";
    }
  }

  /** Start the helper, or with `restart`, restart it with the current settings. */
  private async start(restart: boolean): Promise<void> {
    if (this.closed) return;
    if (!restart && this.supervisor.snapshot().process !== "stopped") {
      this.configure(this.settings.get());
      return;
    }
    const binary = this.resolveBinary();
    if (binary.path === null) {
      this.unavailable = binary.reason;
      log.warn(`Tailscale device not started: ${binary.reason}`);
      this.options.onChange?.();
      return;
    }
    this.unavailable = undefined;
    if (!this.app) return;
    let socket: TailnetSocketServer;
    try {
      socket = await this.ensureSocket();
    } catch (err) {
      this.unavailable = `The gateway could not open its private socket for Tailscale: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(this.unavailable);
      this.options.onChange?.();
      return;
    }
    // Read after the socket is open: the settings are what the owner wants now.
    const settings = this.settings.get();
    if (!settings.enabled) return;
    const tls = this.options.tlsMaterial();
    this.configure(settings);
    await this.supervisor.start({
      binary: binary.path,
      stateDir: join(this.featureDir, "node"),
      hostname: settings.deviceName,
      socketPath: socket.path,
      fallbackCert: tls.cert,
      fallbackKey: tls.key,
      ...(this.env.OMNESIS_TAILSCALE_EMBED_TEST_CONTROL_URL
        ? { controlUrl: this.env.OMNESIS_TAILSCALE_EMBED_TEST_CONTROL_URL }
        : {}),
    });
    this.options.onChange?.();
  }

  private configure(settings: TailscaleSettings): void {
    this.supervisor.send({
      type: "configure",
      public: { enabled: settings.publicAccess, paths: PUBLIC_PATHS },
    });
  }

  private async stopDevice(): Promise<void> {
    this.unavailable = undefined;
    await this.supervisor.stop();
    await this.closeSocket();
    this.options.onChange?.();
  }

  private async ensureSocket(): Promise<TailnetSocketServer> {
    if (this.socket) return this.socket;
    const app = this.app!;
    this.socket = await startTailnetSocketServer({
      path: tailnetSocketPath(this.featureDir, this.env),
      listener: app.listener,
      ...(app.upgrade ? { upgrade: app.upgrade } : {}),
      ...(app.onServer ? { onServer: app.onServer } : {}),
    });
    return this.socket;
  }

  private async closeSocket(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    await socket?.close();
  }

  private onHelperChange(snapshot: SupervisorSnapshot): void {
    const status = snapshot.status;
    const summary = `${snapshot.process}/${status?.backend ?? "-"}/${status?.certificate.source ?? "-"}/${status?.public.state ?? "-"}`;
    if (summary !== this.lastLogged) {
      this.lastLogged = summary;
      if (status?.backend === "running" && status.node) {
        log.info(
          `Tailscale device ${status.node.dnsName} connected; certificate ${status.certificate.source}${status.certificate.reason ? ` (${status.certificate.reason})` : ""}; public address ${status.public.state}`,
        );
      } else if (status?.backend === "needs-login") {
        log.info("Tailscale device is waiting for its owner to sign in");
      }
    }
    this.options.onChange?.();
  }
}

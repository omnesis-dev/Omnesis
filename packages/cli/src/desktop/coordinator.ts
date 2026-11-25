// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { z } from "zod";
import {
  DesktopAccountFailure,
  continued,
  desktopAccountSchema,
  safeBrowserUrl,
  desktopEnrollmentUI,
} from "./account-connect.js";
import {
  desktopCoordinatorDefaults as defaults,
  type CoordinatorDependencies,
  type DesktopSessionTransport,
} from "./coordinator-runtime.js";
import type { DesktopProtocolContext, DesktopProtocolRequest } from "./protocol.js";
import type { DesktopSearchModel } from "./search-model.js";
import type { DesktopConnection } from "./gateway-access.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopEnrollmentRole, DesktopEnrollmentUI, DesktopPairing } from "./enrollment.js";

export interface DesktopState {
  phase: "welcome" | "accountRequired" | "chooseHome" | "preparing" | "ready" | "waiting" | "error";
  mode?: "home" | "joined";
  message?: string;
  connection?: DesktopConnection & { deviceId?: string; collectorDeviceId?: string };
  encrypted?: boolean;
  signup?: { policy?: "invite" | "open"; acmeTermsUrl?: string };
  searchModel?: DesktopSearchModel;
}
const prepareParams = z
  .object({ mode: z.enum(["home", "joined"]), name: z.string().trim().min(1).max(80).optional() })
  .strict();
const discoveryParams = z
  .object({
    intent: z.enum(["existing", "create"]).optional(),
    termsAccepted: z.boolean().optional(),
    invite: z.string().max(2048).optional(),
  })
  .strict();
const healthSchema = z.object({ status: z.literal("ok") });

/** Native views receive verified state; credentials stay on the private bridge and scoped files. */
export class DesktopCoordinator {
  private readonly deps: CoordinatorDependencies;
  private transport: DesktopSessionTransport | undefined;
  private transportIdentity: string | undefined;
  private firstHomeOffered = false;
  constructor(
    private readonly profile: DesktopProfile,
    dependencies: Partial<CoordinatorDependencies> = {},
  ) {
    this.deps = { ...defaults, ...dependencies };
  }

  async handle(
    request: DesktopProtocolRequest,
    context: DesktopProtocolContext,
  ): Promise<DesktopState> {
    try {
      context.signal.throwIfAborted();
      switch (request.command) {
        case "status":
          return await this.status(context.signal);
        case "prepare":
          return await this.prepare(request.params, context);
        case "connect":
          return await this.connect(request.params, context);
        case "openPortal":
          return await this.openPortal(context);
        case "stop": {
          const install = await this.deps.readInstall(this.profile);
          if (!install) return { phase: "welcome" };
          if (!(await this.deps.stopDaemon(this.profile, context.signal)))
            return {
              phase: "error",
              mode: install.mode,
              message: "Omnesis could not confirm that background collection stopped. Try again.",
            };
          await this.close();
          return {
            phase: "waiting",
            mode: install.mode,
            message: "Background collection has stopped. Choose Look again to start it.",
          };
        }
        case "respond":
        case "cancel":
          throw new Error("Interactions are handled by the desktop connection");
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (error instanceof DesktopAccountFailure) return { phase: "error", message: error.message };
      return {
        phase: "error",
        message:
          "Omnesis could not finish this step. Unlock your Mac and try again. Your existing library has been kept.",
      };
    }
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.transportIdentity = undefined;
    await transport?.close();
  }

  private secretOptions() {
    return {
      configDir: this.profile.configDir,
      service: this.profile.secretService,
      backend: "macos-keychain" as const,
    };
  }
  private pairPath(role: DesktopEnrollmentRole) {
    return join(
      this.profile.configDir,
      "cloud-relay",
      `${role === "interactive" ? "cli" : "collector"}-device.json`,
    );
  }

  private async status(signal: AbortSignal): Promise<DesktopState> {
    const install = await this.deps.readInstall(this.profile);
    if (!install) return this.firstHomeOffered ? { phase: "chooseHome" } : { phase: "welcome" };
    if (install.phase !== "configured" || !(await this.deps.protected(this.profile)))
      return {
        phase: "error",
        mode: install.mode,
        message: "Unlock your Mac's Keychain to protect your Omnesis library.",
      };
    signal.throwIfAborted();
    if (install.mode === "joined") return this.joinedState(signal);
    try {
      healthSchema.parse(await this.deps.request(this.profile, "/health", { signal }));
      let account = desktopAccountSchema.parse(
        await this.deps.request(this.profile, "/admin/cloud-relay", { signal }),
      );
      if (!account.account?.linked) {
        account = desktopAccountSchema.parse(
          await this.deps.request(this.profile, "/admin/cloud-relay?signup=1", { signal }),
        );
        return {
          phase: "accountRequired",
          mode: "home",
          encrypted: true,
          ...(account.signup || account.config?.acmeTermsUrl
            ? {
                signup: {
                  ...(account.signup
                    ? {
                        policy: account.signup.inviteOnly ? ("invite" as const) : ("open" as const),
                      }
                    : {}),
                  ...(account.config?.acmeTermsUrl
                    ? { acmeTermsUrl: safeBrowserUrl(account.config.acmeTermsUrl) }
                    : {}),
                },
              }
            : {}),
        };
      }
      const searchModel = await this.deps.searchModel(this.profile, { signal });
      if (searchModel.state === "downloading")
        return {
          phase: "preparing",
          mode: "home",
          encrypted: true,
          searchModel,
          message: "Your local search model is downloading.",
        };
      if (searchModel.state === "needs-download")
        return {
          phase: "error",
          mode: "home",
          encrypted: true,
          searchModel,
          message: "Local search needs its model. Choose Prepare library to retry the download.",
        };
      const connection = await this.deps.connection(this.profile);
      signal.throwIfAborted();
      return {
        phase: "ready",
        mode: "home",
        encrypted: true,
        connection: {
          ...connection,
          collectorDeviceId: await this.deps.localCollectorDeviceId(this.profile),
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        phase: "waiting",
        mode: "home",
        message: "Your private library is starting. Try again in a moment.",
      };
    }
  }

  private async prepare(params: unknown, context: DesktopProtocolContext): Promise<DesktopState> {
    const input = prepareParams.parse(params);
    const existing = await this.deps.readInstall(this.profile);
    if (input.mode === "joined" && !existing)
      return {
        phase: "waiting",
        message:
          "Set up Omnesis on the Mac that will keep your library, then choose Find my library.",
      };
    await this.deps.prepareInstall(this.profile, {
      mode: input.mode,
      totalMemoryBytes: this.deps.memoryBytes(),
      signal: context.signal,
    });
    await this.deps.prepareRuntime(this.profile, context.signal);
    await this.deps.startDaemon(this.profile);
    if (input.mode === "home") {
      await this.waitForHome(context.signal);
      await this.deps.searchModel(this.profile, { start: true, signal: context.signal });
    }
    return this.status(context.signal);
  }

  private async waitForHome(parentSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(180_000)]);
    for (;;) {
      signal.throwIfAborted();
      try {
        healthSchema.parse(await this.deps.request(this.profile, "/health", { signal }));
        return;
      } catch {
        signal.throwIfAborted();
        await this.deps.sleep(signal);
      }
    }
  }

  private async connect(params: unknown, context: DesktopProtocolContext): Promise<DesktopState> {
    const install = await this.deps.readInstall(this.profile);
    if (install?.mode === "home") {
      if (!(await this.deps.protected(this.profile)))
        return {
          phase: "error",
          mode: "home",
          message: "Unlock your Mac's Keychain before connecting your account.",
        };
      await this.deps.startDaemon(this.profile);
      await this.waitForHome(context.signal);
      const state = await this.status(context.signal);
      if (state.phase !== "accountRequired" || params === undefined) return state;
      await this.deps.connectAccount(this.profile, params, context, { request: this.deps.request });
      return this.status(context.signal);
    }
    discoveryParams.parse(params ?? {});
    if (install) {
      await this.deps.prepareInstall(this.profile, {
        mode: "joined",
        totalMemoryBytes: this.deps.memoryBytes(),
        signal: context.signal,
      });
      if (!(await this.deps.protected(this.profile)))
        return {
          phase: "error",
          mode: "joined",
          message: "Unlock your Mac's Keychain before connecting this Mac.",
        };
    }
    const relayUrl = this.deps.relayUrl();
    if (!relayUrl) throw new Error("Account sign-in is not configured");
    const ui = desktopEnrollmentUI(context);
    if (!install) {
      const homes = await this.deps.discover({
        relayUrl,
        name: this.deps.name(),
        signal: context.signal,
        ui,
      });
      if (homes.kind === "no-home") {
        this.firstHomeOffered = true;
        return {
          phase: "chooseHome",
          message: "Choose the Mac that will keep your Omnesis library.",
        };
      }
      await this.deps.prepareInstall(this.profile, {
        mode: "joined",
        totalMemoryBytes: this.deps.memoryBytes(),
        signal: context.signal,
      });
      await this.deps.prepareRuntime(this.profile, context.signal);
    }
    let interactive = await this.savedPair("interactive");
    if (!interactive) interactive = await this.enroll("interactive", relayUrl, ui, context);
    let collector = await this.savedPair("collector");
    if (!collector) {
      collector = await this.deps.enroll({
        role: "collector",
        relayUrl,
        name: this.deps.name(),
        deviceKeyFile: join(this.profile.configDir, "cloud-relay", "collector.key"),
        signal: context.signal,
        deviceKeySecretOptions: this.secretOptions(),
        ui,
        onEvent: () => {},
      });
      if (!sameLibrary(collector, interactive))
        throw new Error("Choose the same library for this Mac's two permissions");
      await this.persist("collector", collector, context.signal);
    }
    if (!sameLibrary(collector, interactive)) throw new Error("The paired library changed");
    await this.persist("interactive", interactive, context.signal);
    await this.persist("collector", collector, context.signal);
    await this.deps.startDaemon(this.profile);
    return this.joinedState(context.signal);
  }

  private async savedPair(role: DesktopEnrollmentRole): Promise<DesktopPairing | null> {
    try {
      const pairing = await this.deps.readPair(this.pairPath(role), this.secretOptions());
      return pairing.kind === (role === "interactive" ? "cli" : "collector") ? pairing : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async enroll(
    role: DesktopEnrollmentRole,
    relayUrl: string,
    ui: DesktopEnrollmentUI,
    context: DesktopProtocolContext,
  ): Promise<DesktopPairing> {
    const pairing = await this.deps.enroll({
      role,
      relayUrl,
      name: this.deps.name(),
      deviceKeyFile: join(
        this.profile.configDir,
        "cloud-relay",
        `${role === "interactive" ? "cli" : "collector"}.key`,
      ),
      signal: context.signal,
      deviceKeySecretOptions: this.secretOptions(),
      ui,
      onEvent: () => {},
    });
    await this.persist(role, pairing, context.signal);
    return pairing;
  }

  private async persist(
    role: DesktopEnrollmentRole,
    pairing: DesktopPairing,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.deps.savePair(this.pairPath(role), pairing, this.secretOptions());
    signal.throwIfAborted();
    await this.deps.saveToken(
      join(this.profile.configDir, role === "interactive" ? "token" : "collector-token"),
      pairing.token,
      this.secretOptions(),
    );
  }

  private async joinedState(signal: AbortSignal): Promise<DesktopState> {
    if (!(await this.deps.protected(this.profile)))
      return {
        phase: "error",
        mode: "joined",
        message: "Unlock your Mac's Keychain to protect this Mac's information.",
      };
    const pairing = await this.savedPair("interactive"),
      collector = await this.savedPair("collector");
    if (!pairing || !collector || !sameLibrary(pairing, collector))
      return {
        phase: "waiting",
        mode: "joined",
        message: "Sign in to finish connecting this Mac to your library.",
      };
    if (!pairing.scopes.includes("admin") || !pairing.scopes.includes("read"))
      throw new Error("Interactive permissions are incomplete");
    if (!collector.scopes.includes("read") || !collector.scopes.includes("write:*"))
      throw new Error("Collection permissions are incomplete");
    const token = await this.deps.readToken(
      join(this.profile.configDir, "token"),
      this.secretOptions(),
    );
    if (token?.trim() !== pairing.token) throw new Error("The interactive credential needs repair");
    const identity = `${pairing.deviceId}:${pairing.token}`;
    if (this.transportIdentity !== identity) {
      await this.close();
      this.transport = await this.deps.startTransport(this.profile);
      this.transportIdentity = identity;
    }
    try {
      await this.deps.verifyTransport(this.transport!, pairing, signal);
    } catch (error) {
      await this.close();
      if (signal.aborted) throw error;
      return {
        phase: "waiting",
        mode: "joined",
        message: "Open Omnesis on the Mac that keeps your library, then try again.",
      };
    }
    signal.throwIfAborted();
    return {
      phase: "ready",
      mode: "joined",
      encrypted: true,
      connection: {
        url: this.transport!.url,
        token: pairing.token,
        deviceId: pairing.deviceId,
        collectorDeviceId: collector.deviceId,
        certificatePEM: pairing.gatewayCertificate,
      },
    };
  }

  private async openPortal(context: DesktopProtocolContext): Promise<DesktopState> {
    const install = await this.deps.readInstall(this.profile);
    let origin: string;
    if (install?.mode === "home") {
      const account = desktopAccountSchema.parse(
        await this.deps.request(this.profile, "/admin/cloud-relay", { signal: context.signal }),
      );
      if (!account.account?.linked || !account.publicOrigin)
        throw new Error("Connect your account first");
      origin = account.publicOrigin;
    } else {
      const pairing = await this.savedPair("interactive");
      if (!pairing) throw new Error("Connect this Mac first");
      origin = pairing.gatewayUrl;
    }
    const base = new URL(safeBrowserUrl(origin));
    if (base.pathname !== "/" || base.search || base.hash)
      throw new Error("Invalid library origin");
    await context.interactions.ask(
      "openBrowser",
      {
        url: new URL("/portal/", base).href,
        message: "Open the advanced web settings in your browser. You may be asked to sign in.",
      },
      continued,
      context.signal,
    );
    return this.status(context.signal);
  }
}

/** Both grants must name the same canonical library and the same independently approved key. */
function sameLibrary(first: DesktopPairing, second: DesktopPairing): boolean {
  return (
    first.gatewayUrl === second.gatewayUrl &&
    (first.tlsSpkiFingerprint && second.tlsSpkiFingerprint
      ? first.tlsSpkiFingerprint === second.tlsSpkiFingerprint
      : first.gatewayFingerprint === second.gatewayFingerprint)
  );
}
